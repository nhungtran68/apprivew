import {spawnSync} from 'node:child_process';
for(const args of [['scripts/prepare-media-assets.mjs'],['node_modules/next/dist/bin/next','build','--webpack']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
