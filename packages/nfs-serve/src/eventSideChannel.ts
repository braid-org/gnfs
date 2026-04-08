import fs from 'fs';
import * as fsDisk from 'node:fs';
import { toStatWithFileId } from './createAsyncNfsHandler.js';

type WatchInterface = {
  peerId: string;
  watch(
    filename: string,
    options?: {
      signal?: AbortSignal;
    }
  ): AsyncIterable<{
    eventType: 'update' | 'headerUpdate' | 'delete';
    filename?: string;
  }>;
  // NOTE: we need to expose the readir since the event doesnt provide this information atm
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<fsDisk.Stats>;
};

export type IndexBody = {
  link: string;
  type?: 'index' | undefined;
  body?: IndexBody;
}[];

// Define the NFS operations we track
type NFSCall =
  | 'getattr'
  | 'lookup'
  | 'remove'
  | 'create'
  | 'mkdir'
  | 'setattr'
  | 'rmdir';

// Define phases/states instead of sequences
enum SidetrackPhase {
  // Delete phases
  Delete_Started = 'delete_started', // Initial state, waiting for any call
  Delete_AttrObtained = 'delete_attr_obtained', // Got getattr, ready for remove
  Delete_Complete = 'delete_complete', // Successfully handled

  // Create phases
  Create_Started = 'create_started', // Initial state
  Create_LookupDone = 'create_lookup_done', // Lookup confirmed file doesn't exist
  Create_Complete = 'create_complete', // Successfully created

  // Modify phases
  Modify_Started = 'modify_started',
  Modify_AttributesReceived = 'modify_attributes_received',
  Modify_Complete = 'modify_complete',
}

// Define valid transitions: from state -> accepted calls -> next state
type StateTransition = {
  from: SidetrackPhase;
  acceptedCalls: NFSCall[];
  to: SidetrackPhase;
  isTerminal?: boolean; // If true, operation completes
};

// Define state machines for each operation type
const STATE_MACHINES: Record<string, StateTransition[]> = {
  delete: [
    {
      from: SidetrackPhase.Delete_Started,
      acceptedCalls: ['getattr', 'lookup'], // Accept either
      to: SidetrackPhase.Delete_AttrObtained,
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['lookup'], // Accept another lookup
      to: SidetrackPhase.Delete_AttrObtained, // Stay in same state
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['getattr'], // Accept another getattr
      to: SidetrackPhase.Delete_AttrObtained, // Stay in same state
    },
    {
      from: SidetrackPhase.Delete_Started,
      acceptedCalls: ['remove'], // Fast path: cached client
      to: SidetrackPhase.Delete_Complete,
      isTerminal: true,
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['remove'],
      to: SidetrackPhase.Delete_Complete,
      isTerminal: true,
    },
  ],

  create: [
    {
      from: SidetrackPhase.Create_Started,
      acceptedCalls: ['lookup'],
      to: SidetrackPhase.Create_LookupDone,
    },
    {
      from: SidetrackPhase.Create_LookupDone,
      acceptedCalls: ['lookup'], // Accept additional lookups
      to: SidetrackPhase.Create_LookupDone, // Stay in same state
    },
    {
      from: SidetrackPhase.Create_LookupDone,
      acceptedCalls: ['create'],
      to: SidetrackPhase.Create_Complete,
      isTerminal: true,
    },
    {
      from: SidetrackPhase.Create_Started,
      acceptedCalls: ['create'], // Fast path: cached client
      to: SidetrackPhase.Create_Complete,
      isTerminal: true,
    },
  ],

  modify: [
    {
      from: SidetrackPhase.Modify_Started,
      acceptedCalls: ['setattr'],
      to: SidetrackPhase.Modify_Complete,
      isTerminal: true,
    },
    {
      from: SidetrackPhase.Modify_Started,
      acceptedCalls: ['getattr'],
      to: SidetrackPhase.Modify_AttributesReceived,
    },
    {
      from: SidetrackPhase.Modify_AttributesReceived,
      acceptedCalls: ['getattr'],
      to: SidetrackPhase.Modify_AttributesReceived,
    },
    {
      from: SidetrackPhase.Modify_AttributesReceived,
      acceptedCalls: ['setattr'],
      to: SidetrackPhase.Modify_Complete,
      isTerminal: true,
    },
  ],

  mkdir: [
    {
      from: SidetrackPhase.Create_Started,
      acceptedCalls: ['lookup'],
      to: SidetrackPhase.Create_LookupDone,
    },
    {
      from: SidetrackPhase.Create_LookupDone,
      acceptedCalls: ['lookup'],
      to: SidetrackPhase.Create_LookupDone,
    },
    {
      from: SidetrackPhase.Create_LookupDone,
      acceptedCalls: ['mkdir'],
      to: SidetrackPhase.Create_Complete,
      isTerminal: true,
    },
    {
      from: SidetrackPhase.Create_Started,
      acceptedCalls: ['mkdir'],
      to: SidetrackPhase.Create_Complete,
      isTerminal: true,
    },
  ],

  rmdir: [
    {
      from: SidetrackPhase.Delete_Started,
      acceptedCalls: ['getattr', 'lookup'],
      to: SidetrackPhase.Delete_AttrObtained,
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['lookup'],
      to: SidetrackPhase.Delete_AttrObtained,
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['getattr'],
      to: SidetrackPhase.Delete_AttrObtained,
    },
    {
      from: SidetrackPhase.Delete_Started,
      acceptedCalls: ['rmdir'],
      to: SidetrackPhase.Delete_Complete,
      isTerminal: true,
    },
    {
      from: SidetrackPhase.Delete_AttrObtained,
      acceptedCalls: ['rmdir'],
      to: SidetrackPhase.Delete_Complete,
      isTerminal: true,
    },
  ],
};

// Active operation tracker
interface ActiveOperation {
  operationType: string;
  currentPhase: SidetrackPhase;
  path: string;
  startedAt: number;
  callHistory: Array<{ call: NFSCall; timestamp: number }>;
  // Preserve cached attributes for this operation to use during interception
  cachedAttributes?: ReturnType<typeof toStatWithFileId>;
}

export class EventSideChannel {
  // paths of interest - the paths the eventSideChanel Watches on

  folderCache: Record<
    string,
    Record<string, ReturnType<typeof toStatWithFileId>>
  > = {};

  registeredPaths: Record<string, AbortController> = {};

  sourceFs: WatchInterface;
  stateMachines: Record<string, ActiveOperation> = {};
  systemPath: string;

  constructor(sourceFs: WatchInterface, systemPath: string) {
    this.sourceFs = sourceFs;
    this.systemPath = systemPath;
  }

  /**
   * register a folder for the side track to watch.
   * The side track will then call onFileCreate and onFileDelete for files that are created or deleted in the folder.
   *
   * Called within the readDirPlus function of the nfs handler
   *
   * @param path the path to the folder
   * @param entries the entries at the point when it was registered
   */
  registerFolder(
    path: string,
    entries: Record<string, ReturnType<typeof toStatWithFileId>>
  ) {
    // console.log('EVENT SIDE TRACK  register folder', path);
    this.folderCache[path] = entries;

    this.registerPath(path);
  }

  registerPath(path: string) {
    if (this.registeredPaths.hasOwnProperty(path)) {
      // console.warn(
      //   `EVENT SIDE TRACK  Path ${path} is already registered for event side tracking. This might lead to duplicate events being fired.`
      // );
    } else {
      const ac = new AbortController();
      const { signal } = ac;

      // console.log(
      //   `EVENT SIDE TRACK  Path ${path} registered for event side tracking.`
      // );
      this.registeredPaths[path] = ac;

      const watcher = this.sourceFs.watch(path, { signal });

      (async () => {
        for await (const event of watcher) {
          this.onEvent({ path, ...event });
        }
      })();
    }
    // called from within getAttributes call
  }

  unregisterPath(path: string) {
    // console.log('EVENT SIDE TRACK UNREGISTER PATH', path);
    delete this.folderCache[path];

    if (this.registeredPaths[path]) {
      // Stop watching the path by aborting the signal
      this.registeredPaths[path].abort();
      delete this.registeredPaths[path];
    }
  }

  // ============================================================
  // NEW STATE MACHINE API
  // ============================================================

  /**
   * Start a new sidetrack operation
   */
  startSidetrack(
    path: string,
    operationType: string,
    timeoutMs: number = 10000 // Longer timeout for flexible paths
  ) {
    const initialPhase = this.getInitialPhase(operationType);

    // Capture cached attributes before they're removed from folderCache
    const parentPath = path.split('/').slice(0, -1).join('/') || '/';
    const fileName = path.split('/').slice(-1)[0]!;
    const cachedAttrs = this.folderCache[parentPath]?.[fileName];

    if (cachedAttrs) {
      console.log(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Captured cached attributes for ${path} before starting ${operationType}`
      );
      console.log(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Captured: Type = ${cachedAttrs.isDirectory() ? 'DIRECTORY' : cachedAttrs.isFile() ? 'FILE' : 'OTHER'}, mode = ${cachedAttrs.mode.toString(8)}, size = ${cachedAttrs.size}`
      );
    } else {
      console.warn(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Warning: No cached attributes found for ${path} when starting ${operationType}`
      );
    }

    this.stateMachines[path] = {
      operationType,
      currentPhase: initialPhase,
      path,
      startedAt: Date.now(),
      callHistory: [],
      cachedAttributes: cachedAttrs,
    };

    const possibleCalls = this.getPossibleCallsFromPhase(
      initialPhase,
      operationType
    );

    console.log(
      `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Started ${operationType} for ${path}`
    );
    console.log(
      `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Current phase: ${initialPhase}`
    );
    console.log(
      `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Accepted calls: ${possibleCalls.join(', ')}`
    );

    // Set timeout
    setTimeout(() => {
      const op = this.stateMachines[path];
      if (op) {
        console.warn(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Timeout for ${operationType} on ${path}`
        );
        console.warn(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Call history:`,
          op.callHistory
        );
        delete this.stateMachines[path];
      }
    }, timeoutMs);
  }

  getCachedAttributes(path: string) {
    // First check if there's an active operation with preserved cached attributes
    const activeOp = this.stateMachines[path];
    if (activeOp?.cachedAttributes) {
      console.log(
        `[SC ${this.sourceFs.peerId}] getCachedAttributes: Returning preserved attributes from active ${activeOp.operationType} operation for ${path}`
      );
      console.log(
        `[SC ${this.sourceFs.peerId}] getCachedAttributes: Type = ${activeOp.cachedAttributes.isDirectory() ? 'DIRECTORY' : activeOp.cachedAttributes.isFile() ? 'FILE' : 'OTHER'}, mode = ${activeOp.cachedAttributes.mode.toString(8)}, size = ${activeOp.cachedAttributes.size}`
      );
      return activeOp.cachedAttributes;
    }
    throw new Error(
      `[SC ${this.sourceFs.peerId}] getCachedAttributes: No cached attributes found for ${path}. This should not happen if checkCall was called first and returned true.`
    );
  }

  getOperationType(path: string): string | undefined {
    const activeOp = this.stateMachines[path];
    return activeOp?.operationType;
  }

  /**
   * Check if an NFS call is acceptable for the current state
   * Returns true if call should be intercepted, false otherwise
   */
  checkCall(path: string, call: NFSCall): boolean {
    const op = this.stateMachines[path];
    if (!op) {
      return false; // No active operation
    }

    const transitions = STATE_MACHINES[op.operationType];
    if (!transitions) {
      throw new Error(
        `No state machine defined for operation type ${op.operationType}, called with call ${call} and path ${path}`
      );
    }

    // Find a transition from current phase that accepts this call
    const transition = transitions.find(
      t => t.from === op.currentPhase && t.acceptedCalls.includes(call)
    );

    if (transition) {
      // Valid call - record it and transition
      console.log(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] ✓ ${path}: '${call}' accepted in phase ${op.currentPhase}`
      );

      op.callHistory.push({
        call,
        timestamp: Date.now(),
      });

      if (transition.isTerminal) {
        console.log(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] ✓ ${path}: Completed ${op.operationType} (total calls: ${op.callHistory.length})`
        );
        console.log(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Call history:`,
          op.callHistory.map(h => h.call).join(' → ')
        );
        delete this.stateMachines[path];
      } else {
        op.currentPhase = transition.to;
        console.log(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] → ${path}: Transitioned to ${op.currentPhase}`
        );
      }

      return true; // Intercept this call
    } else {
      // Unexpected call - but might be a repeated call in current phase
      const canRepeat = transitions!.some(
        t =>
          t.from === op.currentPhase &&
          t.acceptedCalls.includes(call) &&
          t.to === op.currentPhase // Stay in same phase
      );

      if (canRepeat) {
        console.log(
          `[SC ${this.sourceFs.peerId}] [STATE MACHINE] ~ ${path}: '${call}' repeated in ${op.currentPhase} (allowed)`
        );
        op.callHistory.push({ call, timestamp: Date.now() });
        return true; // Intercept it
      }

      // Truly unexpected call
      console.error(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] ✗ ${path}: Unexpected call '${call}' in phase ${op.currentPhase}`
      );
      console.error(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Expected one of: ${this.getPossibleCallsFromPhase(op.currentPhase, op.operationType).join(', ')}`
      );
      console.error(
        `[SC ${this.sourceFs.peerId}] [STATE MACHINE] Call history so far:`,
        op.callHistory.map(h => h.call).join(' → ')
      );

      throw new Error(
        `Unexpected call '${call}' for ${path} in operation ${op.operationType} at phase ${op.currentPhase}`
      );

      // // Don't delete the state machine - keep it for debugging
      // return false; // Don't intercept - let it fall through to normal handling
    }
  }

  /**
   * Get all calls that can be accepted from current phase
   */
  private getPossibleCallsFromPhase(
    phase: SidetrackPhase,
    operationType: string
  ): NFSCall[] {
    const transitions = STATE_MACHINES[operationType];
    if (!transitions) {
      return [];
    }

    const validTransitions = transitions.filter(t => t.from === phase);

    // Collect all unique accepted calls
    const calls = new Set<NFSCall>();
    validTransitions.forEach(t => {
      t.acceptedCalls.forEach(call => calls.add(call));
    });

    return Array.from(calls);
  }

  /**
   * Get the initial phase for an operation type
   */
  private getInitialPhase(operationType: string): SidetrackPhase {
    const initialPhases: Record<string, SidetrackPhase> = {
      delete: SidetrackPhase.Delete_Started,
      create: SidetrackPhase.Create_Started,
      modify: SidetrackPhase.Modify_Started,
      mkdir: SidetrackPhase.Create_Started, // Similar to create
      rmdir: SidetrackPhase.Delete_Started, // Similar to delete
    };

    return initialPhases[operationType] || SidetrackPhase.Modify_Started;
  }

  /**
   * For debugging: get current state
   */
  getState(path: string): ActiveOperation | undefined {
    return this.stateMachines[path];
  }

  /**
   * Check if a path has an active operation
   */
  hasActiveOperation(path: string): boolean {
    return !!this.stateMachines[path];
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  /**
   * receives an event for a path it previously registered for.
   * This function opens up sidechannels if needed
   * @param event
   * @returns
   */
  onEvent(event: {
    path: string;
    eventType: 'update' | 'headerUpdate' | 'delete';
    filename?: string;
    body?:
      | string
      | null
      | undefined
      | {
          ctime: Date;
          mtime: Date;
          atime: Date;
          size: number;
        }
      | IndexBody;
  }) {
    console.log(
      `[SC ${this.sourceFs.peerId}] Received event for ${event.path}: ${event.eventType}`
    );

    // console.log('folder. cache ', this.folderCache);
    // console.log(event);
    // console.log(event.body);
    // Check if this is a folder event
    if (this.folderCache[event.path]) {
      if (event.eventType === 'update') {
        if (!event.body || !Array.isArray(event.body)) {
          throw new Error(
            'Expected folder update event to have body with IndexBody'
          );
        }
        this.onFolderChange(event.path, event.body);
      } else {
        console.log(
          `[SC ${this.sourceFs.peerId}] ${event.eventType} for folder not yet handled`
        );
      }

      return;
    }

    if (event.eventType === 'update' || event.eventType === 'headerUpdate') {
      this.onFileModify(event.path);
    } else if (event.eventType === 'delete') {
      this.onFileDelete(event.path);
    }
  }

  async onFolderChange(folderPath: string, folderContent: IndexBody) {
    // Read the current folder entries
    const cachedEntries = this.folderCache[folderPath] || {};
    const currentEntries = folderContent.map(entry => entry.link); // filter out the event log file
    console.log(
      `[SC ${this.sourceFs.peerId}] - onFolderChange for ${folderPath} comparing cached entries [${Object.keys(cachedEntries).join(', ')}] with current entries [${currentEntries.join(', ')}] for folder ${folderPath}`
    );

    const removedEntries: string[] = [];

    // Find removed files
    for (const entry of Object.keys(cachedEntries)) {
      if (!currentEntries.includes(entry)) {
        const filePath =
          folderPath === '/' ? `/${entry}` : `${folderPath}/${entry}`;

        if (this.hasActiveOperation(filePath)) {
          console.log(
            `[SC ${this.sourceFs.peerId}] Detected removed entry ${entry} in folder ${folderPath}, but currently active sidetrack for this path, skipping event`,
            filePath
          );
          continue;
        }

        if (this.folderCache[filePath]) {
          // if the removed entry is a folder we also need to unregister it from the side track
          this.onFolderDelete(filePath);
        } else {
          this.onFileDelete(filePath);
        }

        removedEntries.push(entry);
      }
    }

    const addedEntries: Record<
      string,
      ReturnType<typeof toStatWithFileId>
    > = {};

    // Find added files
    for (const entry of currentEntries) {
      if (!Object.keys(cachedEntries).includes(entry)) {
        console.log(
          `[SC ${this.sourceFs.peerId}] Detected new entry ${entry} in folder ${folderPath}, checking if file or folder`
        );

        const newEntryStats = await this.sourceFs.lstat(
          folderPath + '/' + entry
        );

        addedEntries[entry] = toStatWithFileId(newEntryStats, Buffer.alloc(0));

        const creationPath =
          folderPath === '/' ? `${entry}` : `${folderPath}/${entry}`;
        if (newEntryStats.isDirectory()) {
          // console.log(
          //   `[SC ${this.sourceFs.peerId}] Detected new folder ${entry} in folder ${folderPath}, registering for event side tracking`
          // );
          this.onFolderCreate(creationPath);
        } else if (newEntryStats.isFile()) {
          this.onFileCreate(creationPath);
        } else {
          // TODO add symlink support
          throw new Error(
            `[SC ${this.sourceFs.peerId}] Detected new entry ${entry} in folder ${folderPath}, but it is neither a file nor a folder`
          );
        }
      }
    }

    for (const removedEntry of removedEntries) {
      console.log(
        `[SC ${this.sourceFs.peerId}] Sidechannel revmoves entry ${removedEntry} from cache for folder ${folderPath}`
      );
      delete cachedEntries[removedEntry];
    }

    for (const addedEntry of Object.keys(addedEntries)) {
      cachedEntries[addedEntry] = addedEntries[addedEntry]!;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] Sidechannel setup for changed folder ${folderPath} done and started`,
      Object.keys(cachedEntries)
    );
  }

  async readFolder(path: string): Promise<string[]> {
    // This is a placeholder - the actual implementation would use the fs interface
    // For now, return empty array
    try {
      return this.sourceFs.readdir(path);
    } catch (err) {
      console.error(`Error reading folder ${path} in event side channel:`, err);
      throw err;
    }
  }

  onFolderDelete(path: string) {
    console.log(`[SC ${this.sourceFs.peerId}] - onFolderDelete ${path}`);

    if (this.hasActiveOperation(path)) {
      console.log(
        `[SC ${this.sourceFs.peerId}] - onFolderDelete skipped, already active operation for ${path}`
      );
      return;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onFolderDelete starting rmdir sidetrack for ${path}`
    );
    this.startSidetrack(path, 'rmdir');

    // remove on the mounted path - this will trigger the nfs server which is then intercepted
    fs.promises
      .rmdir(this.systemPath + path)
      .then(() => {
        // Successfully deleted, now remove from cache to prevent duplicate delete events
        if (this.folderCache[path]) {
          console.log(
            `[SC ${this.sourceFs.peerId}] Removing folder ${path} from cache to prevent duplicate events`
          );
          delete this.folderCache[path];
        }
      })
      .catch(err => {
        console.error(
          `Error removing folder ${this.systemPath + path} in side track:`,
          err
        );
      });
  }

  onFileDelete(path: string) {
    if (this.hasActiveOperation(path)) {
      console.log(
        `[SC ${this.sourceFs.peerId}] - onFileDelete skipped, already active operation for ${path}`
      );
      return;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onFileDelete starting delete sidetrack for ${path}`
    );
    this.startSidetrack(path, 'delete');

    if (path.startsWith('/')) {
      path = path.slice(1);
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] starting FS sidechannel fs.promises.rm('${this.systemPath + path}')`
    );
    // remove on the mounted path - this will trigger the nfs server which is then intercepted
    fs.promises
      .rm(this.systemPath + path)
      .then(() => {
        // Successfully deleted, now remove from cache to prevent duplicate delete events
        const fullPath = path.startsWith('/') ? path : `/${path}`;
        const parentPath = fullPath.split('/').slice(0, -1).join('/') || '/';
        const fileName = fullPath.split('/').slice(-1)[0]!;

        if (this.folderCache[parentPath]?.[fileName]) {
          console.log(
            `[SC ${this.sourceFs.peerId}] Removing ${fileName} from folder cache for ${parentPath} to prevent duplicate events`
          );
          delete this.folderCache[parentPath][fileName];
        }
      })
      .catch(err => {
        console.error(
          `Error removing file ${this.systemPath + path} in side track:`,
          err
        );
      });
  }

  onFolderCreate(path: string) {
    if (this.hasActiveOperation(path)) {
      console.log(
        `[SC ${this.sourceFs.peerId}] - onFolderCreate skipped, already active operation for ${path}`
      );
      return;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onFolderCreate starting mkdir sidetrack for ${path}`
    );
    this.startSidetrack(path, 'mkdir');

    if (path.startsWith('/')) {
      path = path.slice(1);
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onFolderCreate - calling mkdir `
    );

    // create on the mounted path - this will trigger the nfs server which is then intercepted
    fs.promises
      .mkdir(this.systemPath + path)
      .then(() => {
        // Successfully created, now add to cache to prevent duplicate create events
        const fullPath = path.startsWith('/') ? path : `/${path}`;
        console.log(
          `[SC ${this.sourceFs.peerId}] Adding folder ${fullPath} to cache to prevent duplicate events`
        );
        this.registerFolder(fullPath, {});
      })
      .catch(err => {
        console.error(
          `Error creating folder ${this.systemPath + path} in side track:`,
          err
        );
      });
  }

  onFileCreate(path: string) {
    if (this.hasActiveOperation(path)) {
      console.log(
        `[SC ${this.sourceFs.peerId}] - onFileCreate skipped, already active operation for ${path}`
      );
      return;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onFileCreate starting create sidetrack for ${path}`
    );
    this.startSidetrack(path, 'create');

    if (path.startsWith('/')) {
      path = path.slice(1);
    }

    // create on the mounted path - this will trigger the nfs server which is then intercepted
    // Important: Close the file handle immediately to avoid resource leak
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    const parentPath = fullPath.split('/').slice(0, -1).join('/') || '/';
    const fileName = fullPath.split('/').slice(-1)[0]!;

    fs.promises
      .open(this.systemPath + path, 'wx')
      .then(async fileHandle => {
        // The NFS CREATE call has been triggered, now close the handle to avoid leak
        await fileHandle.close();

        // Successfully created, now add to cache to prevent duplicate create events
        // Get the file stats from the backing store
        try {
          const stats = await this.sourceFs.lstat(fullPath);
          if (!this.folderCache[parentPath]) {
            this.folderCache[parentPath] = {};
          }
          this.folderCache[parentPath][fileName] = toStatWithFileId(
            stats,
            Buffer.alloc(0)
          );
          console.log(
            `[SC ${this.sourceFs.peerId}] Added ${fileName} to folder cache for ${parentPath} to prevent duplicate events`
          );
        } catch (err) {
          console.error(
            `[SC ${this.sourceFs.peerId}] Error getting stats for ${fullPath} after create:`,
            err
          );
        }
      })
      .catch(err => {
        console.error(
          `Error creating file ${this.systemPath + path} in side track:`,
          err
        );
      });
  }

  onFileModify(path: string) {
    if (this.hasActiveOperation(path)) {
      console.log(
        `[SC ${this.sourceFs.peerId}] - onFileModify skipped, already active operation for ${path}`
      );
      return;
    }

    console.log(
      `[SC ${this.sourceFs.peerId}] - onModify starting modify sidetrack for ${path}`
    );
    this.startSidetrack(path, 'modify');

    // trigger utimes with magic date on the mounted path - this will trigger the nfs server which is then intercepted
    const MAGIC_DATE = new Date(0);
    fs.promises
      .utimes(this.systemPath + path, MAGIC_DATE, MAGIC_DATE)
      .catch(err => {
        console.error(
          `Error modifying file ${this.systemPath + path} in side track:`,
          err
        );
      });
  }
}
