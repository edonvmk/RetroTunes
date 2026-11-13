import { PlatformDriver } from './types';
import { darwinDriver } from './darwin';
import { win32Driver } from './win32';
import { linuxDriver } from './linux';

export * from './types';

function resolvePlatformDriver(): PlatformDriver {
  switch (process.platform) {
    case 'darwin':
      return darwinDriver;
    case 'win32':
      return win32Driver;
    default:
      return linuxDriver;
  }
}

export const platformDriver: PlatformDriver = resolvePlatformDriver();
