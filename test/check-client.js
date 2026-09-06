const fs = require('node:fs');
const source = fs.readFileSync('public/index.html','utf8').split('<script>')[1].split('</script>')[0];
new Function(source);
