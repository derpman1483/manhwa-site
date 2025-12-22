const { spawn } = require('child_process');

function startChildProcess() {
const child = spawn('node', ['main.js']);
child.on('exit', (code, signal) => {
  console.log(`Child process exited with code ${code} and signal ${signal}`);
  startChildProcess();
});
}
startChildProcess();