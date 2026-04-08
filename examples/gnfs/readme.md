# gnfs

## Prepare:


### Install
`pnpm install` - in the root folder of this repo 

### Build

`pnpm run build` in the root folder of this repo to build nfs 


## Run Double mount

Doublemount uses two nfs servers and two separate mounts to simulate remote events

`pnpm run dev2 --serve-path / --mount-path-1 ~/nfs/mount1 --mount-path-2 ~/nfs/mount2`

--servePath  is the path in the virtual file system to serve
--mount-path-1 is the path on the local system to mount the first folder to


--servePath-2  is the path in the virtual file system to serve
--mount-path-2 is the path on the local system to mount the second folder to

