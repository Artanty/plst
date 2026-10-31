const fs = require('fs');
const path = require('path');

class LogManager {
  constructor(config = {}) {
    this.logDir = config.logDir || path.join(process.cwd(), 'build/logs');
    this.debugLog = path.join(this.logDir, 'tag_debug.log');
    this.historyLog = path.join(this.logDir, 'tag_history.log');
    this.errorLog = path.join(this.logDir, 'tag_error.log');
    this.maxEntries = config.maxEntries || 500;
    this.clearTagDebugLogFile = config.clearTagDebugLogFile
    
    this.initLogs();
  }

  initLogs() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    if (this.clearTagDebugLogFile) {
      this.manageLog(this.debugLog, 0); // Clear debug log completely
    }
    this.manageLog(this.historyLog);
    this.manageLog(this.errorLog);
  }

  manageLog(logFilePath, maxEntries = this.maxEntries) {
    try {
      if (fs.existsSync(logFilePath)) {
        const lines = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(line => line.trim());
        if (lines.length > maxEntries) {
          fs.writeFileSync(logFilePath, '');
          this.debug(`Cleared history log (${lines.length} entries exceeded ${maxEntries} limit)`);
          return true;
        }
      }
      return false;
    } catch (error) {
      this.error(`History log clearance failed for ${logFilePath}: ${error.message}`);
      throw error;
    }
  }

  debug(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(this.debugLog, `[DEBUG ${timestamp}] ${message}\n`);
  }

  history(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(this.historyLog, `${timestamp} - ${message}\n`);
  }

  error(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(this.errorLog, `[ERROR ${timestamp}] ${message}\n`);
  }
}

module.exports = LogManager;