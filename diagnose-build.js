const fs = require('fs')
const yaml = require('js-yaml')
const { execSync } = require('child_process')

const playbook = yaml.load(fs.readFileSync('antora-playbook.yml', 'utf8'))
console.log('[DOC-3358] Configured site.url:', playbook.site.url)

execSync('npm run build:antora', { stdio: 'inherit' })

const homepage = fs.readFileSync('build/site/home/index.html', 'utf8')
const canonical = homepage.match(/<link rel="canonical" href="([^"]+)"/)
console.log('[DOC-3358] Generated homepage canonical:', canonical ? canonical[1] : 'NOT FOUND')
