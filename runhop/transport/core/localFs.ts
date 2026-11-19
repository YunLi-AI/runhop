// From SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/localFs.ts

import * as path from 'path';
import { LocalFileSystem } from './fs';

const fs = new LocalFileSystem(path);

export default fs;
