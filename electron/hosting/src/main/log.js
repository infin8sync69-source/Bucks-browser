import fs from 'node:fs';
import path from 'node:path';

let logFile = null;

/** Call once after app is ready to also mirror logs to <userData>/logs/main.log */
export function initFileLogging(userData) {
  try {
    const dir = path.join(userData, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    // keep the log bounded
    try {
      const st = fs.statSync(logFile);
      if (st.size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    } catch {}
  } catch {
    logFile = null;
  }
}

function write(level, scope, args) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  if (logFile) {
    fs.appendFile(logFile, line + '\n', () => {});
  }
}

export function createLogger(scope) {
  return {
    debug: (...a) => process.env.BUCKS_DEBUG && write('DEBUG', scope, a),
    info: (...a) => write('INFO', scope, a),
    warn: (...a) => write('WARN', scope, a),
    error: (...a) => write('ERROR', scope, a),
  };
}
