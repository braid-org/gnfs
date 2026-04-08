#!/usr/bin/env node

import * as net from 'net';
import * as path from 'node:path';
import { exec } from 'child_process';
import { Command } from 'commander';
import {
  createAsyncNfsHandler,
  createNfs3Server,
  createFileHandleManager,
  EventSideChannel,
} from 'nfs-serve';
import { createMemoryBackedState } from '../lib/state/memory-backed-state';
import { Gnfs } from '../lib/gnfs/gnfs';

// Function to check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();

    server.listen(port, () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });

    server.on('error', () => {
      resolve(false);
    });
  });
}

// Function to find an available port starting from the given port
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  let attempts = 0;
  const maxAttempts = 100; // Prevent infinite loop

  while (attempts < maxAttempts) {
    if (await isPortAvailable(port)) {
      return port;
    }
    // console.log(`Port ${port} is in use, trying next port...`);
    port++;
    attempts++;
  }

  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts starting from ${startPort}`
  );
}

interface NfsServerResult {
  server: any;
  ready: Promise<void>;
  stop: () => Promise<void>;
}

function startNfsServer(
  serverFolder: string,
  mountFolder: string,
  port: number,
  gnfsInstance: Gnfs
): NfsServerResult {
  console.log(`Starting NFS server...`);
  console.log(`Server folder: ${serverFolder}`);
  console.log(`Mount folder: ${mountFolder}`);
  console.log(`Port: ${port}`);

  let nfsServer: any;

  let serverReadyResolver: () => void;
  let serverReadyRejecter: (error: Error) => void;
  const serverReadyPromise = new Promise<void>((resolve, reject) => {
    serverReadyResolver = resolve;
    serverReadyRejecter = reject;
  });

  // Start the NFS server
  (async () => {
    try {
      // Use the provided GNFS instance instead of creating a new one
      const asyncGnfs = gnfsInstance;

      console.log('Creating file handle manager...');
      const fileHandleManager = createFileHandleManager(
        serverFolder,
        Math.floor(Date.now() / 1000 - 25 * 365.25 * 24 * 60 * 60) * 1000000
      );

      console.log('Creating async NFS handlers...');
      const asyncHandlers = createAsyncNfsHandler({
        fileHandleManager: fileHandleManager,
        asyncFs: asyncGnfs as any,
        eventSideTrack: new EventSideChannel(asyncGnfs, mountFolder + '/'),
      });

      console.log('Creating NFS3 server...');
      nfsServer = createNfs3Server(asyncHandlers);

      console.log(`Starting NFS server on port ${port}...`);
      nfsServer.listen(port, () => {
        console.log(`NFS server is listening on port ${port}`);
        serverReadyResolver();
      });

      // Handle errors
      nfsServer.on('error', (error: Error) => {
        console.log(`NFS server error: ${error.message}`, true);
        serverReadyRejecter(error);
      });
    } catch (error) {
      const err = error as Error;
      const errorMsg = `Error starting NFS server: ${err.message}`;
      console.log(errorMsg, true);
      console.error(errorMsg);

      // @ts-expect-error -- control follw not correct here
      serverReadyRejecter(err);
    }
  })();

  // Return an object with server control methods and the ready promise
  return {
    server: nfsServer,
    ready: serverReadyPromise,
    stop: async () => {
      console.log('Stopping NFS server...');
      await nfsServer.closeAllConnections();
      if (nfsServer) {
        return new Promise<void>(resolve => {
          nfsServer.close(() => {
            console.log('NFS server closed');
            resolve();
          });
        });
      } else {
        return Promise.resolve();
      }
    },
  };
}

function mountNfsShare(mountPoint: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // console.log(`Mounting NFS share at ${mountPoint} on port ${port}...`);

    // // Ensure mount point directory exists
    // if (!fsDisk.existsSync(mountPoint)) {
    //   // console.log(`Creating mount point directory: ${mountPoint}`);
    //   fsDisk.mkdirSync(mountPoint, { recursive: true });
    // }

    // Try to unmount first in case something is already mounted
    exec(`umount -f ${mountPoint}`, unmountErr => {
      if (unmountErr) {
        // console.log(`No existing mount to unmount at ${mountPoint}`);
      } else {
        // console.log(`Unmounted existing mount at ${mountPoint}`);
      }

      // Mount the NFS share
      const mountCommand = `mount_nfs -o nolocks,soft,retrans=2,timeo=10,vers=3,tcp,rsize=131072,actimeo=0,noac,acregmin=0,acregmax=0,acdirmin=0,acdirmax=0,acrootdirmin=0,acrootdirmax=0,port=${port},mountport=${port} localhost:/ ${mountPoint}`;

      exec(mountCommand, mountErr => {
        if (mountErr) {
          console.error(`Failed to mount ${mountPoint}:`, mountErr.message);
          reject(mountErr);
          return;
        }

        // console.log(`${mountPoint} mounted successfully`);

        // Verify the mount worked by checking if mount output contains our mount point
        exec('mount', (checkErr, stdout) => {
          if (checkErr) {
            console.error('Failed to verify mount:', checkErr.message);
            reject(checkErr);
            return;
          }

          if (stdout.includes(mountPoint)) {
            // console.log('Mount verification successful');
            resolve();
          } else {
            console.error(
              'Mount verification failed - mount point not found in mount output'
            );
            reject(new Error('Mount verification failed'));
          }
        });
      });
    });
  });
}

function unmountNfsShare(mountFolderPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Unmounting NFS share at ${mountFolderPath}...`);

    exec(`umount ${mountFolderPath}`, (err, stdout, stderr) => {
      if (err) {
        // Check if it's just because the mount point doesn't exist
        if (
          err.message.includes('not currently mounted') ||
          err.message.includes('No such file or directory')
        ) {
          console.log(`Nothing mounted on ${mountFolderPath}`);
          resolve();
          return;
        }
        console.error(`Failed to unmount ${mountFolderPath}:`, err.message);
        reject(err);
        return;
      }

      console.log(`${mountFolderPath} unmounted successfully`);
      resolve();
    });
  });
}

interface ProgramOptions {
  servePath: string;
  mountPath1: string;
  mountPath2: string;
  spawn?: string;
  port?: number;
  logFile?: string;
}

async function main() {
  const program = new Command();

  program
    .name('virtual-nfs')
    .description('CLI tool to serve virtual filesystem via NFS with two mounts')
    .version('1.0.0')
    .option(
      '--serve-path <servePath>',
      'Folder where to serve the virtual filesystem from'
    )
    .option(
      '--mount-path-1 <mountPath1>',
      'First folder where to mount the virtual filesystem',
      './virtual-nfs-mount-1'
    )
    .option(
      '--mount-path-2 <mountPath2>',
      'Second folder where to mount the virtual filesystem',
      './virtual-nfs-mount-2'
    )
    .option('--spawn <cmd>', 'Command to execute after mounting (omit to skip)')
    .option(
      '--port <number>',
      'Port for first NFS server (default: first free port starting from 13617)'
    );

  const options = program.parse().opts() as ProgramOptions;
  console.log('Starting virtual NFS server with options:', options);

  if (options.port === undefined) {
    options.port = await findAvailablePort(13617);
  }

  if (!options.servePath) {
    console.error('Error: --serve-path option is required');
    process.exit(1);
  }

  // Convert serve path to absolute path relative to current working directory
  if (!path.isAbsolute(options.servePath)) {
    options.servePath = path.resolve(process.cwd(), options.servePath);
  }

  // Convert mount paths to absolute paths relative to current working directory
  if (!path.isAbsolute(options.mountPath1)) {
    options.mountPath1 = path.resolve(process.cwd(), options.mountPath1);
  }

  if (!path.isAbsolute(options.mountPath2)) {
    options.mountPath2 = path.resolve(process.cwd(), options.mountPath2);
  }

  console.log('Mount path 1:', options.mountPath1);
  console.log('Mount path 2:', options.mountPath2);
  console.log('Port 1:', options.port);

  // Find a second port for the second server
  const port2 = await findAvailablePort(
    parseInt(options.port as unknown as string) + 1
  );
  console.log('Port 2:', port2);

  let nfsServer1: NfsServerResult | undefined;
  let nfsServer2: NfsServerResult | undefined;

  // Handle graceful shutdown on SIGINT/SIGTERM
  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    try {
      // Try to unmount both mounts
      await unmountNfsShare(options.mountPath1);
    } catch (err) {
      // Ignore unmount errors during shutdown
    }

    try {
      await unmountNfsShare(options.mountPath2);
    } catch (err) {
      // Ignore unmount errors during shutdown
    }

    // Stop both NFS servers
    if (nfsServer1) {
      console.log('Stopping NFS server 1...');
      await nfsServer1.stop();
    }

    if (nfsServer2) {
      console.log('Stopping NFS server 2...');
      await nfsServer2.stop();
    }

    console.log('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    // Create a shared backing store (memory state provider)
    console.log('Creating shared backing store...');
    const memoryStateProvider = createMemoryBackedState();

    // Create initial test file in the shared backing store
    await memoryStateProvider.put(
      '/my_serve_folder/file.txt',
      {
        type: 'file',
        body: 'Hello from shared backing store!',
      },
      'external-peer'
    );

    // Create two GNFS instances, both connected to the same backing store
    console.log('Creating GNFS instance 1...');
    const gnfs1 = new Gnfs(options.mountPath1);
    gnfs1.connect(memoryStateProvider);

    console.log('Creating GNFS instance 2...');
    const gnfs2 = new Gnfs(options.mountPath2);
    gnfs2.connect(memoryStateProvider);

    // Start both NFS servers, each with its own GNFS instance
    console.log('\n=== Starting NFS Server 1 ===');
    nfsServer1 = startNfsServer(
      options.servePath,
      options.mountPath1,
      parseInt(options.port as unknown as string),
      gnfs1
    );

    console.log('\n=== Starting NFS Server 2 ===');
    nfsServer2 = startNfsServer(
      options.servePath,
      options.mountPath2,
      port2,
      gnfs2
    );

    // Wait for both NFS servers to be ready
    console.log('\n=== Waiting for servers to be ready ===');
    await Promise.all([nfsServer1.ready, nfsServer2.ready]);
    console.log('Both NFS servers are ready!');

    // Mount both NFS shares
    console.log('\n=== Mounting NFS shares ===');
    await Promise.all([
      mountNfsShare(
        options.mountPath1,
        parseInt(options.port as unknown as string)
      ),
      mountNfsShare(options.mountPath2, port2),
    ]);

    console.log('\n✅ Both NFS filesystems mounted successfully!');
    console.log(
      `📁 Mount point 1: ${options.mountPath1} (port ${options.port})`
    );
    console.log(`📁 Mount point 2: ${options.mountPath2} (port ${port2})`);
    console.log(
      `\nBoth mounts share the same backing store via separate GNFS instances.`
    );
    console.log(
      `\nYou can now explore the virtual filesystem at: ${options.mountPath1} and ${options.mountPath2}`
    );
    console.log('\nPress Ctrl+C to stop the servers and unmount.\n');
  } catch (error) {
    const err = error as Error;
    console.error('\nFailed to start NFS servers:', err.message);
    console.error(err.stack);

    // Try to unmount on error
    try {
      await unmountNfsShare(options.mountPath1);
    } catch (unmountErr) {
      // Ignore unmount errors during cleanup
    }

    try {
      await unmountNfsShare(options.mountPath2);
    } catch (unmountErr) {
      // Ignore unmount errors during cleanup
    }

    // Stop NFS servers on error
    if (nfsServer1) {
      await nfsServer1.stop();
    }

    if (nfsServer2) {
      await nfsServer2.stop();
    }

    process.exit(1);
  }
}

main();
