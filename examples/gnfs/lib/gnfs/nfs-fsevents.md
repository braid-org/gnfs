# NFS event propagation

NFS-3 does *not* produce filesystem events (FSEvents on the mac) when a file changes on the server. 
Changes happening on the server reach the client only via polling.

On the other hand - Changes produced by the client within the mounted folder do produce events. 

Applications like emacs that rely on file events for reloading instead of polling will not reload the content and never reflect
the server state once loaded - even if the clients file cache had been updated by other applications.

## Client side event simulation

When nfs-server is running on the same host as the client mounting the network folder it utilizing the filesystem access to the mounted folder as a side channel to simulate the events. 

TL;DR: We observe the files of interest using fs.watch on the `serving fs`- the fs attached to nfs-serve <note>I think when you're talking about the `serving fs`, this is just for the demo you're making now, and in general this will be for the backingstate.  Is that right?  The `serving fs` you're talking about is just a particular backingstate, that happens to use fs.watch to detect changes and then `send()` them to `gnfs`?</note>- and propagate the events by operating on the mounted folder. 

### Files of interest

The server should not propagate all file changes to the client. A change in a file not seen by the client yet shouldn't produce events on the client. Why? 

- Some protocols don't provide a wildcard event recursive subscription.

Having a recursive watch on braid for example would just not work - since the subscription requires a discovery of a resource first - a recursive wildcard subscription would not be feasable

- events may lead to unintended materializations on the client.

Lets say the file `/mounted_folder/path/to/file.txt` changes on the server but the client has never
looked up `file.txt`. (No prior discovery via the finder or an open call to that file)
If we propagate the changes to the client the propagation to the folder would lead to a materialization. 

#### Subscribe to files and folders of interest

To only watch the files / folders we are interested we can define "of interest" as files that the client has seen or opened.

<note block>
Mike: More specifically, we care about the files that GNFS is *subscribed* to.

<br><br>This is presuming we model the components in this state bus like this:<pre>
    ----------
   | OS Apps  |
    ----------
     |
   --|- GNFS ------
  |  ├<---------   |
  | NFS client  |  |   <-- Notifications run through
  | NFS server  |  |       the inner side loop
  |  ├--------->   |
   --|-------------
     |
   ---------------
  | Backing State |
   ---------------
</pre>
In this model, GNFS subscribes to state on the backing state. The user's apps will periodically read or write from files, which will trigger GNFS to open a subscription with the backing state, and also GNFS can periodically close a subscription with the backing state after a period of inactivity (but we might not bother implementing that yet).  In the long run, we'll might also built a UI for the user to view and configure what is being stored/cached/subscribed.<br><br>
In any case, when you're saying that we only "watch the files/folders we are interested in, and define 'of interest' as `_____`, I think we can define quite simply and specifically as "the resources that GNFS is subscribed to."
</note>

Every file that was opened, its stats where asked of or had been looked up is a file that the client is (or was) interessted in. 

We can build a map of observers by hooking into the lookup, stats function open function and add the path to the list of subscribers. For those elements in the list we observe the corresponding paths.

#### Unsubscribe files and folders

The list of observers will grow with the usage of the fs. For the current implementation this is a known issue and we gonna investigate the posibilities to cleanup or remove event handlers depending on the usecases 

<note block>Yeah we can perfect unsubscribes later. We might start with just a command-line command, or curl command, or json file editing.</note>

### Side channel in detail

To "simulate" file events on the client we need to distinguish between `change` events and `rename` events.

### File change event simulation

Any modification in the `serving fs` produces a `change` event for the given node when watching on a file or the direct parent directory.

1. a `watch` on the `serving fs` for the file of interest (see lazy propagation) triggers a callback with a `change` event
2. store the changed path on the server in a `toPropagateChange`-set
3. use `fs.promises.utimes` to set the `mtime` on the file with a magic date (1970-1-1-00:00), <note>I'd suggest not using 000000000, which might get actually set by accident in some other program that leaves that field null, but rather something odd like 0230202402, or even something in the far future like 9999789999 </note> this will trigger `setAttributes` call to the nfs server 
4. detect the magic date on set attribute - check if the file is in the `toPropagateChange`-set
5. don't forward the stats to the `serving fs` but return success including the current files attributes from `serving fs`
6. 🎉 client has the new stats on the client and triggers a change event on the mounted drive

### File removal/create/move simulation

<note block>Mike: I'm not exactly sure which part of the workflow you're talking about right here — sounds like this is about capturing the events from the filesystem-backingstate accurately?  I'd keep in mind that we don't need to perfect that right now.  Fs.watch can be annoying, and in the end, we're going to be receiving these as clean braid `put` and `delete`-style updates. There will be no `rename`. The point of the fs-backingstate is just as a quick stub before we replace it with a braid-http backingstate.</note>

A `removal`, `move` as well as a `creation` of files produce a `rename` event(s) in the `serving fs`.

Question: what events does the client need?
- "removal" - `rename` if the file was openend, stats where requested (e.g. by readdir)
- "creation" - `rename` if the parent folder was "opened" (readdir) 
- "rename" - `rename` same as removal and creation

<br>

1. the `watch` on the `serving fs` for the **file of interest** (see lazy propagation) triggers a callback with a `rename` event
2. the file was observerd directly (privous stats call) -> The client assumes the existence of the file 
   1. `rename` got to represent a deletion (?) <note>unkown: double check this hypothesis</note>
   2. store the renamed path in `toPropagateDeletion` set
   3. use `fs.promises.unlink` to remove trigger a `unlink` call to the nfs server 
   4. check the `toPropagateDeletion` set in the unlink and just return success and skip the unlink on the `serving fs`
3. the file was observed because of the parent dir (no `stats` call because the file did not exists) 
   1. `rename` represents a creation
   2. store the renamed path in `toPropagateCreation` set
   3. use `fs.open` to trigger trigger a `create` call to the nfs server 
   4. check the `toPropagateCreation` set in the nfs create function and just return success and skip the open call on the `serving fs`
4. 🎉 client has the parent folder index and the client and triggers the expected `rename` event on the mounted drive


## Next steps

1. produces events in gnfs to provide the interface to nfs-serve
2. an interface that produce change in the `memory-backed-state` (using braid http in the browser?)
3. implement the side channel logic in nfs-serve


## Limitations

- recursive watchers like using fs.watch('path', {recursive}) will not work properly <note>recursive watch is pretty fragile in fs anyway</note>
- ...

<note block>Are you here ^ referring to recursive watchers on the backingstate's fs?  Or on the client?</note>


# Event mapping

 We have two categories of events comming from the backing state: 
 `update` and `delete`
 
 an `update` can be creation or a modification
 a `delete` is a deletion
 
 the update and delete events fire for **'index'**, **'body'** or **'header'**
 
 # Deletion of a resource
 
 A *deletion* of a resource like `/path/to/file.txt` will lead to send calls with:

 1. `delete` payload on `/path/to/file.txt`
 2. `update` payload of type **'index'** on `/path/to/` (its entries have changed because of the deletion)
 3. (?) `update` payload of type **'header'** on `/path/to/`
 
 In node's filesystems' watch we see:
 1. a `rename` event on the watcher of path '/path/to/' with filename 'file.txt'
 2. a `rename` event on the watcher of path '/path/to/file.txt' with filename 'file.txt'
 
 # Creation of a resource

 A *creation* of a resource like `/path/to/file.txt` will lead to send calls with:

 1. an `update` payload on with type **'body'** on with `/path/to/file.txt`
 2. an `update` payload on with type **'header'** on with `/path/to/file.txt` (its metadata like mtime and size have changed because of the creation)
 3. an `update` payload with type **'index'** on `/path/to/`
 4. (?) `update` payload of type **'header'** on `/path/to/`
 
 In node's filesystems' watch we see:
 1. a `rename` event for a watcher on path '/path/to/'
 2. **NO EVENT** event on /path/to/file.txt - we can't observe non existing files directly
 
 # Modification of a resource

 A modification of a resource like /path/to/file.txt will lead to send calls with: 
 1. an `update` payload on with type **'body'** on with `/path/to/file.txt`
 2. an `update` payload on with type **'header'** on with `/path/to/file.txt`x
   
In node's filesystems' watch we see:
1. a `rename` event on the watcher of path '/path/to/'
2. a `change` event on the watcher of path '/path/to/file.txt'

## Insights 

The native filesystem api's watch method behaves pretty unreliably.
1. The results may not only depend on timing but also on event loop queuing logic - the tests behave differently when a debugger hit a breakpoint compared to if not. 
2. Multiple subsequent events get coalesced not only of the same time. 

Modify 'file_A', remove 'file_A' -> ['change']
Modify 'file_A', wait 5 seconds, remove 'file_A' -> ['change', 'rename']

furhter investigations may show if 1. and 2. are node implementation specific or os fsevent queuing. 
If this is a OS behaviour - we can be less strict in producing events from nfs. 
If this is a node implementation issue we would need to produce the correct event order for other 
non node apps that may relay on fsevent's to work properly.



 