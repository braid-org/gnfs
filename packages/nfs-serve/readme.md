# nfs-serve

A TypeScript implementation of an NFSv3 (Network File System version 3) server that provides a complete NFS server implementation with support for standard file operations including read, write, create, delete, and directory operations.

## Features

- **Complete NFSv3 Implementation**: Full support for NFSv3 protocol including all standard procedures
- **TypeScript Support**: Written entirely in TypeScript with full type safety
- **Node.js Integration**: Works with any Node.js filesystem implementation that supports the `fs/promises` API
- **File Handle Management**: Built-in file handle manager for tracking open files and directories
- **Mount Support**: Handles both NFS and MOUNT protocol requests
- **Error Handling**: Comprehensive error handling with proper NFS error codes
- **Testing**: Extensive test suite covering all operations

## Installation

```bash
pnpm install nfs-serve
```

## Quick Start

Here's a simple example of how to create an NFS server that serves files from a local directory:

```typescript
import * as fs from 'node:fs';
import * as path from 'path';
import {
  createNfs3Server,
  createAsyncNfsHandler,
  createFileHandleManager,
} from 'nfs-serve';

async function startNfsServer() {
  // Define the directory you want to serve
  const servePath = path.resolve('./nfs-share');

  // Ensure the directory exists
  await fs.promises.mkdir(servePath, { recursive: true });

  // Create a file handle manager
  const fileHandleManager = createFileHandleManager(servePath, 1);

  // Create NFS handlers using Node.js fs promises API
  const nfsHandlers = createAsyncNfsHandler({
    fileHandleManager,
    asyncFs: fs.promises,
  });

  // Create the NFS server
  const server = createNfs3Server(nfsHandlers);

  // Start listening on the standard NFS port (2049)
  server.listen(2049, () => {
    console.log(`NFS server is running on port 2049`);
    console.log(`Serving directory: ${servePath}`);
    console.log('You can now mount this server using:');
    console.log(
      `sudo mount -t nfs localhost:${servePath} /mnt/nfs -o nolock,port=2049,mountport=2049`
    );
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down NFS server...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

startNfsServer().catch(console.error);
```

## API Reference

### Core Functions

#### `createNfs3Server(handlers): net.Server`

Creates an NFSv3 server instance with the provided handlers.

**Parameters:**

- `handlers`: Object containing all NFS procedure handlers
- Returns: A Node.js net.Server instance

#### `createAsyncNfsHandler(options): Handlers`

Creates NFS handlers that work with any Node.js-compatible filesystem.

**Parameters:**

- `options.fileHandleManager`: File handle manager instance
- `options.asyncFs`: Node.js `fs/promises` compatible filesystem API
- Returns: Complete set of NFS procedure handlers

#### `createFileHandleManager(rootPath, startingHandle): FileHandleManager`

Creates a file handle manager for tracking file and directory handles.

**Parameters:**

- `rootPath`: Root directory path to serve
- `startingHandle`: Starting handle number (typically 1)
- Returns: File handle manager instance

### NFS Procedures Supported

The server supports all standard NFSv3 procedures:

**File Operations:**

- `LOOKUP` - Look up a filename in a directory
- `CREATE` - Create a regular file
- `READ` - Read data from a file
- `WRITE` - Write data to a file
- `REMOVE` - Remove a file
- `RENAME` - Rename a file or directory
- `GETATTR` - Get file attributes
- `SETATTR` - Set file attributes
- `COMMIT` - Commit cached data to stable storage

**Directory Operations:**

- `MKDIR` - Create a directory
- `RMDIR` - Remove a directory
- `READDIR` - Read directory entries
- `READDIRPLUS` - Read directory entries with attributes

**Filesystem Operations:**

- `FSSTAT` - Get filesystem statistics
- `FSINFO` - Get filesystem information
- `PATHCONF` - Get path configuration information
- `ACCESS` - Check access permissions

**Special Files:**

- `SYMLINK` - Create a symbolic link
- `READLINK` - Read a symbolic link
- `LINK` - Create a hard link
- `MKNOD` - Create a special file (not implemented for regular files)

## Advanced Usage

### Custom Filesystem Implementation

You can use any filesystem implementation that supports the Node.js `fs/promises` API:

```typescript
import { createAsyncNfsHandler } from 'nfs-serve';
import { CustomFileSystem } from './custom-filesystem';

const customFs = new CustomFileSystem(); // Must implement fs/promises API

const nfsHandlers = createAsyncNfsHandler({
  fileHandleManager,
  asyncFs: customFs,
});
```

### Multiple Mount Points

The server supports different mount points by customizing the mount handler:

```typescript
const nfsHandlers = createAsyncNfsHandler({
  fileHandleManager,
  asyncFs: fs.promises,
  // Custom mount handler for multiple paths
  mount: async (dirPath: string) => {
    // Handle different mount paths
    if (dirPath === '/data') {
      // Serve different directory for /data mount
      const dataHandle = fileHandleManager.getHandleByPath('/path/to/data');
      return { status: nfsstat3.OK, fileHandle: dataHandle.nfsHandle };
    }
    // Default behavior
    // ...
  },
});
```

### Error Handling

The server provides comprehensive error handling with proper NFS error codes:

```typescript
import { nfsstat3 } from 'nfs-serve';

// NFS status codes include:
// nfsstat3.OK - Operation successful
// nfsstat3.ERR_NOENT - No such file or directory
// nfsstat3.ERR_ACCES - Permission denied
// nfsstat3.ERR_EXIST - File exists
// nfsstat3.ERR_NOTDIR - Not a directory
// nfsstat3.ERR_ISDIR - Is a directory
// nfsstat3.ERR_NOTEMPTY - Directory not empty
// nfsstat3.ERR_STALE - Stale file handle
// nfsstat3.ERR_IO - I/O error
// nfsstat3.ERR_NOTSUPP - Operation not supported
```

## Testing

The package includes a comprehensive test suite. To run the tests:

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

## Client Usage

### Mounting on Unix/Linux

```bash
# Mount the NFS server
sudo mount -t nfs localhost:/ /mnt/nfs -o nolock,port=2049,mountport=2049

# Or mount with specific options
sudo mount -t nfs -o vers=3,udp,nolock localhost:/ /mnt/nfs

# Unmount when done
sudo umount /mnt/nfs
```

### Mounting on macOS

```bash
# Mount the NFS server
sudo mount -t nfs localhost:/ /mnt/nfs -o nolock,port=2049,mountport=2049

# Or with additional options
sudo mount -t nfs -o vers=3,udp,nolock,resvport localhost:/ /mnt/nfs
```

### Access from Applications

Once mounted, the NFS share can be accessed like any other directory:

```bash
# List files
ls -la /mnt/nfs

# Create files
touch /mnt/nfs/test.txt

# Copy files
cp /path/to/local/file.txt /mnt/nfs/

# Read files
cat /mnt/nfs/test.txt
```

## Development

### Building from Source

```bash
# Clone the repository
git clone <repository-url>
cd nfs-serve

# Install dependencies
pnpm install

# Build the TypeScript code
pnpm build

# Run in development mode
pnpm dev
```

### Project Structure

```
src/
├── index.ts                    # Main exports
├── server.ts                   # NFS server implementation
├── createAsyncNfsHandler.ts    # Handler factory
├── createFileHandleManager.ts  # File handle management
├── rpc/                        # RPC protocol handling
│   ├── createRpcReply.ts
│   ├── nfs/                    # NFS protocol procedures
│   └── mount/                  # Mount protocol handling
└── test/                       # Test files
    └── setup/                  # Test setup utilities
```
