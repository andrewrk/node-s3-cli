#!/usr/bin/env node

var minimist = require('minimist');
var osenv = require('osenv');
var ini = require('ini');
var fs = require('fs');
var path = require('path');
var args = minimist(process.argv.slice(2), {
  'default': {
    config: path.join(osenv.home(), '.s3cfg'),
  },
});

var fns = {
  'sync': cmdSync,
  'ls': cmdList,
  'help': cmdHelp,
};

var accessKeyId, secretAccessKey;
fs.readFile(args.config, {encoding: 'utf8'}, function(err, contents) {
  if (err) {
    console.error("This utility needs a config file formatted the same as for s3cmd");
    process.exit(1);
    return;
  }
  var config = ini.parse(contents);
  if (config && config.default) {
    accessKeyId = config.default.access_key;
    secretAccessKey = config.default.secret_key;
  }
  if (!secretAccessKey || !accessKeyId) {
    console.error("Config file missing access_key or secret_key");
    process.exit(1);
    return;
  }
  var cmd = args._.shift();
  var fn = fns[cmd];
  if (!fn) fn = cmdHelp;
  fn();
});


function cmdSync() {

}

function cmdList() {

}

function cmdHelp() {
  console.log("Usage: s3 (command) (command arguments)");
  console.log("Commands:", Object.keys(fns).join(" "));
}
