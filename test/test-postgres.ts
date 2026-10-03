import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Windows pg_ctl creates the restricted process required by hosted admin runners. */
export class TestPostgres extends EmbeddedPostgres {
  private windowsStarted = false;
  private async control(args: string[]) {
    const { pg_ctl } = await import('@embedded-postgres/windows-x64');
    // Detached PostgreSQL can inherit pipe handles on Windows. Ignoring stdio
    // lets pg_ctl finish immediately; startup diagnostics are in startup.log.
    return new Promise<void>((resolve, reject) => {
      const child=spawn(pg_ctl,args,{windowsHide:true,stdio:'ignore'});
      const timeout=setTimeout(()=>{child.kill();reject(new Error('pg_ctl timed out'));},40000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('close',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(new Error(`pg_ctl failed with exit code ${code}`));});
    });
  }
  override async start() {
    if (process.platform !== 'win32') return super.start();
    await this.control(['start', '-D', this.options.databaseDir, '-l',
      path.join(this.options.databaseDir, 'startup.log'), '-o',
      `-p ${this.options.port} -h 127.0.0.1`, '-w', '-t', '30']);
    this.windowsStarted = true;
  }
  override async stop() {
    if (process.platform !== 'win32') return super.stop();
    const directory = path.resolve(this.options.databaseDir);
    const temp = path.resolve(os.tmpdir()) + path.sep;
    if (!directory.startsWith(temp) || !path.basename(directory).startsWith('chamego-test-')) {
      throw new Error('Refusing to remove a database outside the test temporary directory');
    }
    const hasPid = await fs.access(path.join(directory, 'postmaster.pid')).then(() => true, () => false);
    if (this.windowsStarted || hasPid) {
      await this.control(['stop', '-D', directory, '-m', 'fast', '-w', '-t', '30']);
      this.windowsStarted = false;
    }
    // Only delete our temporary cluster after it has stopped.
    await fs.rm(directory, { recursive: true, force: true });
  }
}
