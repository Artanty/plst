const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class VersionManager {
  constructor(config, logManager) {
    this.config = config;
    this.logManager = logManager;
  }

  getStagedVersion(folderConfig) {
    try {
      this.logManager.debug(`Getting staged version for ${folderConfig.folder}`);
      const content = execSync(`git show :${folderConfig.folder}package.json`, {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      const version = JSON.parse(content).version;
      this.logManager.debug(`Staged version for ${folderConfig.folder}: ${version}`);
      return version;
    } catch (error) {
      this.logManager.debug(`Error getting staged version for ${folderConfig.folder}: ${error.message}`);
      return null;
    }
  }

  getHeadVersion(folderConfig) {
    try {
      this.logManager.debug(`Checking HEAD version for ${folderConfig.folder}`);
      
      try {
        execSync('git rev-parse HEAD', { stdio: 'pipe' });
      } catch {
        this.logManager.debug('No HEAD commit exists');
        return '0.0.0';
      }

      try {
        const exists = execSync(
          `git ls-tree --name-only HEAD ${folderConfig.folder}package.json`,
          { stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
        if (!exists) {
          this.logManager.debug(`package.json does not exist in HEAD for ${folderConfig.folder}`);
          return '0.0.0';
        }
      } catch {
        this.logManager.debug(`Error checking if package.json exists in HEAD for ${folderConfig.folder}`);
        return '0.0.0';
      }

      const content = execSync(
        `git show HEAD:${folderConfig.folder}package.json`,
        { stdio: 'pipe', encoding: 'utf-8' }
      ).trim();

      if (!content) {
        this.logManager.debug(`Empty package.json content in HEAD for ${folderConfig.folder}`);
        return '0.0.0';
      }

      const pkg = JSON.parse(content);
      if (!pkg.version) {
        this.logManager.debug(`No version field in HEAD package.json for ${folderConfig.folder}`);
        return '0.0.0';
      }

      this.logManager.debug(`HEAD version for ${folderConfig.folder}: ${pkg.version}`);
      return pkg.version;
    } catch (error) {
      this.logManager.debug(`Unexpected error in getHeadVersion for ${folderConfig.folder}: ${error.message}`);
      return '0.0.0';
    }
  }

  hasFolderChanges(folderConfig) {
    try {
      this.logManager.debug(`Checking for changes in ${folderConfig.folder}`);
      const changes = execSync(
        `git diff --cached --name-only -- ${folderConfig.folder}`,
        { stdio: 'pipe', encoding: 'utf-8' }
      ).trim();
      
      this.logManager.debug(`Raw changes for ${folderConfig.folder}: ${changes}`);
      
      if (!changes) {
        this.logManager.debug(`No changes detected in ${folderConfig.folder}`);
        return false;
      }
      
      const changedFiles = changes.split('\n').filter(Boolean);
      const nonPackageChanges = changedFiles.filter(file => !file.endsWith('package.json'));
      
      this.logManager.debug(`Non-package.json changes for ${folderConfig.folder}: ${nonPackageChanges.join(', ')}`);
      return nonPackageChanges.length > 0;
    } catch (error) {
      this.logManager.debug(`Error checking changes for ${folderConfig.folder}: ${error.message}`);
      return false;
    }
  }

  bumpPatchVersion(folderConfig) {
    try {
      this.logManager.debug(`Starting patch version bump for ${folderConfig.folder}`);
      
      const currentContent = fs.readFileSync(folderConfig.path, 'utf8');
      const pkg = JSON.parse(currentContent);
      const [major, minor, patch] = pkg.version.split('.').map(Number);
      
      const newVersion = `${major}.${minor}.${patch + 1}`;
      pkg.version = newVersion;
      
      fs.writeFileSync(folderConfig.path, JSON.stringify(pkg, null, 2) + '\n');
      this.logManager.debug(`Updated version for ${folderConfig.folder} to ${newVersion}`);
      
      execSync(`git add ${folderConfig.path}`, { stdio: 'inherit' });
      this.logManager.debug(`Staged package.json changes for ${folderConfig.folder}`);
      
      return newVersion;
    } catch (error) {
      this.logManager.debug(`Error bumping version for ${folderConfig.folder}: ${error.message}`);
      return null;
    }
  }

  handleMinorVersionBump(folderConfig, stagedVersion, headVersion) {
    try {
      this.logManager.debug(`Checking for minor version bump in ${folderConfig.folder}`);
      
      const [headMajor, headMinor] = headVersion.split('.').map(Number);
      const [stagedMajor, stagedMinor] = stagedVersion.split('.').map(Number);
      
      if (stagedMajor === headMajor && stagedMinor > headMinor) {
        this.logManager.debug(`Minor version manually increased in ${folderConfig.folder} - resetting patch to 0`);
        
        const currentContent = fs.readFileSync(folderConfig.path, 'utf8');
        const pkg = JSON.parse(currentContent);
        
        const newVersion = `${stagedMajor}.${stagedMinor}.0`;
        pkg.version = newVersion;
        
        fs.writeFileSync(folderConfig.path, JSON.stringify(pkg, null, 2) + '\n');
        this.logManager.debug(`Reset patch to 0 for ${folderConfig.folder}: ${newVersion}`);
        
        execSync(`git add ${folderConfig.path}`, { stdio: 'inherit' });
        this.logManager.debug(`Staged package.json changes for ${folderConfig.folder}`);
        
        return newVersion;
      }
      
      return null;
    } catch (error) {
      this.logManager.debug(`Error in handleMinorVersionBump for ${folderConfig.folder}: ${error.message}`);
      return null;
    }
  }

  updateEnvTagVersion() {
    try {
      this.logManager.debug('Updating TAG_VERSION in .env');
      
      const backVersion = this.getCurrentVersion(this.config.folders.back);
      const webVersion = this.getCurrentVersion(this.config.folders.web);
      
      this.logManager.debug(`Back version: ${backVersion}, Web version: ${webVersion}`);
      
      const [backMajor, backMinor, backPatch] = backVersion.split('.').map(Number);
      const [webMajor, webMinor, webPatch] = webVersion.split('.').map(Number);
      
      const newTagVersion = `${backMajor}.${backMinor}.${backPatch}.${webMajor}.${webMinor}.${webPatch}`;
      // build
      let buildEnvContent = fs.existsSync(this.config.buildEnvFile) 
        ? fs.readFileSync(this.config.buildEnvFile, 'utf8') 
        : '';
      
      if (buildEnvContent.includes('TAG_VERSION=')) {
        buildEnvContent = buildEnvContent.replace(
          /TAG_VERSION=.*/,
          `TAG_VERSION=${newTagVersion}`
        );
      } else {
        buildEnvContent += `TAG_VERSION=${newTagVersion}\n`;
      }
      
      fs.writeFileSync(this.config.buildEnvFile, buildEnvContent.trim());


      
      this.logManager.history(`Updated TAG_VERSION to ${newTagVersion} (not committed)`);
      this.logManager.debug(`New TAG_VERSION: ${newTagVersion}`);
      
      return newTagVersion;
    } catch (error) {
      this.logManager.debug(`Error updating TAG_VERSION: ${error.message}`);
      return null;
    }
  }

  getCurrentVersion(folderConfig) {
    try {
      this.logManager.debug(`Reading current version from ${folderConfig.path}`);
      
      const content = fs.readFileSync(folderConfig.path, 'utf8');
      const pkg = JSON.parse(content);
      
      if (!pkg.version) {
        this.logManager.debug(`No version field found in ${folderConfig.path}`);
        return '0.0.0';
      }
      
      if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
        this.logManager.debug(`Invalid version format in ${folderConfig.path}: ${pkg.version}`);
        return '0.0.0';
      }
      
      this.logManager.debug(`Current version for ${folderConfig.folder}: ${pkg.version}`);
      return pkg.version;
    } catch (error) {
      this.logManager.debug(`Error reading ${folderConfig.path}: ${error.message}`);
      return '0.0.0';
    }
  }
}

module.exports = VersionManager;