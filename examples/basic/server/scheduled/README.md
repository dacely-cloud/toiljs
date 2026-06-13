# scheduled/

Reserved for scheduled tasks: cron-style jobs that will run on the Toil edge runtime.

The scheduling API has not shipped yet. The folder convention exists today so your project
layout will not change when it lands; until then, anything in here is ignored by the build
(only `.ts` files with a server surface are compiled).
