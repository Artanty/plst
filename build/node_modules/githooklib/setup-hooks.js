#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOOKS_PATH = path.join(__dirname, './hooks');
const PROJECT_ROOT = path.join(process.cwd(), '..');
const BUILD_DIR = process.cwd();

function setHookPermissions() {
  const hooksDir = path.join(__dirname, 'hooks');
  const hookFiles = fs.readdirSync(hooksDir);

  for (const file of hookFiles) {
    const hookPath = path.join(hooksDir, file);
    fs.chmodSync(hookPath, 0o755);
  }
  console.log('✅ Hook permissions set to executable');
}

function createGitignore() {
  const gitignorePath = path.join(BUILD_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, 'node_modules\n.env\nlogs\n');
    console.log('✅ Created .gitignore');
  } else {
    console.log('⏭️  .gitignore already exists');
  }
}

function createEnvFile() {
  const envPath = path.join(BUILD_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '');
    console.log('✅ Created .env');
  } else {
    console.log('⏭️  .env already exists');
  }
}

function configureGitHooks() {
  execSync(`git config core.hooksPath ${HOOKS_PATH}`, { stdio: 'pipe' });
  console.log('✅ Git hooks configured at:', HOOKS_PATH);
}

function verifyConfiguration() {
  console.log('\n--- Verification ---');

  // Check core.hooksPath
  const hooksPath = execSync('git config --get core.hooksPath', { encoding: 'utf8' }).trim();
  if (hooksPath === HOOKS_PATH) {
    console.log('✅ core.hooksPath:', hooksPath);
  } else {
    console.log('❌ core.hooksPath mismatch:', hooksPath, '(expected', HOOKS_PATH + ')');
    return false;
  }

  // Check hook files are executable
  const hooksDir = path.join(__dirname, 'hooks');
  const hookFiles = fs.readdirSync(hooksDir);
  let allExecutable = true;
  for (const file of hookFiles) {
    const hookPath = path.join(hooksDir, file);
    const stat = fs.statSync(hookPath);
    const isExecutable = !!(stat.mode & 0o111);
    if (isExecutable) {
      console.log('✅ Hook executable:', file);
    } else {
      console.log('❌ Hook NOT executable:', file);
      allExecutable = false;
    }
  }

  // Check web/ and back/ folders exist (siblings of build/)
  const hasWeb = fs.existsSync(path.join(PROJECT_ROOT, 'web'));
  const hasBack = fs.existsSync(path.join(PROJECT_ROOT, 'back'));

  if (!hasWeb && !hasBack) {
    console.log('❌ Error: web/ and back/ folders not found. githooklib requires at least one.');
    return false;
  }
  if (!hasWeb) {
    console.log('⚠️  web/ folder not found — tag version will use zeros for web');
  }
  if (!hasBack) {
    console.log('⚠️  back/ folder not found — tag version will use zeros for back');
  }

  // Check .env exists
  const envPath = path.join(BUILD_DIR, '.env');
  if (fs.existsSync(envPath)) {
    console.log('✅ .env exists');
  } else {
    console.log('❌ .env not found');
    allExecutable = false;
  }

  // Check .gitignore exists
  const gitignorePath = path.join(BUILD_DIR, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    console.log('✅ .gitignore exists');
  } else {
    console.log('❌ .gitignore not found');
    allExecutable = false;
  }

  console.log('--- End Verification ---\n');
  return allExecutable;
}

// Only configure if in a Git repo
try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });

  configureGitHooks();
  setHookPermissions();
  createGitignore();
  createEnvFile();

  const ok = verifyConfiguration();
  if (ok) {
    console.log('✅ githooklib installed and configured successfully');
  } else {
    console.error('⚠️  githooklib installed but verification found issues');
  }
} catch {
  console.log('⚠️  Not a Git repo - skipping hook setup');
}
