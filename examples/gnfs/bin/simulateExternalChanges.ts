import { createMemoryBackedState } from '../lib/state/memory-backed-state';

export async function simulateExternalChanges(
  memoryStateProvider: ReturnType<typeof createMemoryBackedState>
): Promise<void> {
  console.log('Setting up external change simulation...');

  // Create initial folder structure
  const initialFiles = [
    {
      path: '/stable-folder/stable-subfolder/stable-file.txt',
      content: 'Hello World',
    },
    {
      path: '/changing-folder/stable-subfolder/stable-file.txt',
      content: 'Hello World',
    },
    {
      path: '/changing-folder/changing-subfolder/changing-1-file.txt',
      content: 'Hello World',
    },
    {
      path: '/changing-folder/changing-subfolder/changing-10-file.txt',
      content: 'Hello World',
    },
    {
      path: '/changing-folder/blink-10-subfolder/file.txt',
      content: 'I disapear every 10 seconds and appear every 10 seconds again',
    },
    {
      path: '/changing-folder/blink-10-file.txt',
      content: 'I disapear every 10 seconds and appear every 10 seconds again',
    },
    { path: '/changing-folder/stable-file.txt', content: 'I am here to stay' },
    {
      path: '/blink-10-folder/folder/file.txt',
      content:
        'I appear and disapear because of the parent folder of my parent folder',
    },
  ];

  // Create all initial files
  for (const file of initialFiles) {
    await memoryStateProvider.put(
      file.path,
      { type: 'file', body: file.content },
      'external-peer'
    );
  }

  // Track state for blinking files/folders
  let changing1Content = 'Hello World';
  let changing10Content = 'Hello World';
  let blink10Visible = true;
  let blink1Visible = true;

  // 1 second interval - updates changing-1-file.txt
  setInterval(async () => {
    changing1Content =
      changing1Content === 'Hello World' ? 'Hello Mars' : 'Hello World';
    await memoryStateProvider.put(
      '/changing-folder/changing-subfolder/changing-1-file.txt',
      { type: 'file', body: changing1Content },
      'external-peer'
    );
    console.log(`Updated changing-1-file.txt: ${changing1Content}`);

    blink1Visible = !blink1Visible;
    if (blink1Visible) {
      await memoryStateProvider.put(
        '/changing-folder/blink-1-subfolder',
        { type: 'index' },
        'external-peer'
      );
    } else {
      await memoryStateProvider.del(
        '/changing-folder/blink-1-subfolder',
        'external-peer'
      );
    }
  }, 1000);

  //   // 10 second interval - updates changing-10-file.txt, toggles blink-10-subfolder, blink-10-file.txt, and blink-10-folder
  //   setInterval(async () => {
  //     // Update changing-10-file.txt content
  //     changing10Content =
  //       changing10Content === 'Hello World' ? 'Hello Mars' : 'Hello World';
  //     await memoryStateProvider.put(
  //       '/changing-folder/changing-subfolder/changing-10-file.txt',
  //       { type: 'file', body: changing10Content },
  //       'external-peer'
  //     );
  //     console.log(`Updated changing-10-file.txt: ${changing10Content}`);

  //     // Toggle visibility of blink-10 resources
  //     blink10Visible = !blink10Visible;

  //     if (blink10Visible) {
  //       // Create blink-10-subfolder and its file
  //       await memoryStateProvider.put(
  //         '/changing-folder/blink-10-subfolder',
  //         { type: 'index' },
  //         'external-peer'
  //       );
  //       await memoryStateProvider.put(
  //         '/changing-folder/blink-10-subfolder/file.txt',
  //         {
  //           type: 'file',
  //           body: 'I disapear every 10 seconds and appear every 10 seconds again',
  //         },
  //         'external-peer'
  //       );

  //       // Create blink-10-file.txt
  //       await memoryStateProvider.put(
  //         '/changing-folder/blink-10-file.txt',
  //         {
  //           type: 'file',
  //           body: 'I disapear every 10 seconds and appear every 10 seconds again',
  //         },
  //         'external-peer'
  //       );

  //       // Create blink-10-folder with subfolder and file
  //       await memoryStateProvider.put(
  //         '/blink-10-folder',
  //         { type: 'index' },
  //         'external-peer'
  //       );
  //       await memoryStateProvider.put(
  //         '/blink-10-folder/folder',
  //         { type: 'index' },
  //         'external-peer'
  //       );
  //       await memoryStateProvider.put(
  //         '/blink-10-folder/folder/file.txt',
  //         {
  //           type: 'file',
  //           body: 'I appear and disapear because of the parent folder of my parent folder',
  //         },
  //         'external-peer'
  //       );

  //       console.log('Made blink-10 resources visible');
  //     } else {
  //       // Delete blink-10-subfolder (recursive)
  //       memoryStateProvider.del(
  //         '/changing-folder/blink-10-subfolder/file.txt',
  //         'external-peer'
  //       );
  //       memoryStateProvider.del(
  //         '/changing-folder/blink-10-subfolder',
  //         'external-peer'
  //       );

  //       // Delete blink-10-file.txt
  //       memoryStateProvider.del(
  //         '/changing-folder/blink-10-file.txt',
  //         'external-peer'
  //       );

  //       // Delete blink-10-folder (recursive)
  //       memoryStateProvider.del(
  //         '/blink-10-folder/folder/file.txt',
  //         'external-peer'
  //       );
  //       memoryStateProvider.del('/blink-10-folder/folder', 'external-peer');
  //       memoryStateProvider.del('/blink-10-folder', 'external-peer');

  //       console.log('Hid blink-10 resources');
  //     }
  //   }, 10000);

  // 1 second interval - creates and renames folder: B -> BR -> BRA -> BRAID -> BRAID.O (skipping BRAID.)
  const folderNames = [
    '_WATCH_THIS',
    '_WATCH_THIS',
    '_WATCH_THIS',
    '_WATCH_THIS',
    '_WATCH_THIS',
    '_WATCH_THIS',
    '_B',
    '_BR',
    '_BRA',
    '_BRAID',
    '_BRAID.O',
    '_BRAID.OR',
    '_BRAID.ORG',
  ];
  let folderIndex = 0;

  setInterval(async () => {
    // Remove the previous folder if it exists
    if (folderIndex > 0) {
      const previousFolder = `/changing-folder/${folderNames[folderIndex - 1]}`;
      try {
        memoryStateProvider.del(previousFolder, 'external-peer');
        console.log(`Removed folder: ${folderNames[folderIndex - 1]}`);
      } catch (err) {
        // Ignore if folder doesn't exist
      }
    }

    // Create the new folder
    const newFolder = `/changing-folder/${folderNames[folderIndex]}`;
    await memoryStateProvider.put(
      newFolder,
      { type: 'index' },
      'external-peer'
    );
    console.log(`Created folder: ${folderNames[folderIndex]}`);

    // Move to the next folder name
    folderIndex++;

    // Reset if we've gone through all folder names
    if (folderIndex >= folderNames.length) {
      folderIndex = 0;
    }
  }, 1000);

  console.log('External change simulation started');
}
