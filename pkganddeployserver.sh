#/bin/bash
npm run build
cd '/opt/projects/json-stream-app/.next'
cp -r static standalone/.next/static || exit 1
zip -r  bjsonbuild.zip standalone
cp bjsonbuild.zip /opt/projects/json-stream-app/

if [ "$1" = "pkgonly" ]; then
  exit 0
fi

scp bjsonbuild.zip root@204.13.232.121:~/
ssh root@204.13.232.121 "unzip -o bjsonbuild.zip -d  /opt/bigjsontool/"
# ssh root@204.13.232.121 "node /opt/bigjsontool/standalone/server.js & >> /opt/bigjsontool/out.log 2>&1"