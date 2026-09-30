const { app } = require('electron');
app.whenReady().then(() => { console.log('APP_PATH=' + app.getAppPath()); console.log('CWD=' + process.cwd()); console.log('EXE=' + process.execPath); app.exit(0); });
