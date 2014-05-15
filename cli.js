#!/usr/bin/env node

var minimist = require('minimist');
var osenv = require('osenv');
var ini = require('ini');
var fs = require('fs');
var path = require('path');
var s3 = require('s3');
var url = require('url');
var args = minimist(process.argv.slice(2), {
  'default': {
    config: path.join(osenv.home(), '.s3cfg'),
  },
  'boolean': ['recursive'],
});

var fns = {
  'sync': cmdSync,
  'ls': cmdList,
  'help': cmdHelp,
};

var client;
fs.readFile(args.config, {encoding: 'utf8'}, function(err, contents) {
  if (err) {
    console.error("This utility needs a config file formatted the same as for s3cmd");
    process.exit(1);
    return;
  }
  var config = ini.parse(contents);
  var accessKeyId, secretAccessKey;
  if (config && config.default) {
    accessKeyId = config.default.access_key;
    secretAccessKey = config.default.secret_key;
  }
  if (!secretAccessKey || !accessKeyId) {
    console.error("Config file missing access_key or secret_key");
    process.exit(1);
    return;
  }
  client = s3.createClient({
    s3Options: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    },
  });
  var cmd = args._.shift();
  var fn = fns[cmd];
  if (!fn) fn = cmdHelp;
  fn();
});


function cmdSync() {

}

function cmdList() {
  var recursive = args.recursive;
  var s3Url = args._[0];
  var parts = parseS3Url(s3Url);
  var params = {
    recursive: recursive,
    s3Params: {
      Bucket: parts.bucket,
      Prefix: parts.key,
      Delimiter: recursive ? null : '/',
    },
  };
  var finder = client.listObjects(params);
  finder.on('data', function(data) {
    data.CommonPrefixes.forEach(function(dirObject) {
      console.log("DIR " + dirObject.Prefix);
    });
    data.Contents.forEach(function(object) {
      console.log(object.LastModified + " " + object.Size + " " + object.Key);
    });
  });
}

function cmdHelp() {
  console.log("Usage: s3 (command) (command arguments)");
  console.log("Commands:", Object.keys(fns).join(" "));
}

function parseS3Url(s3Url) {
  if (!s3Url) {
    console.error("Expected S3 URL argument");
    process.exit(1);
  }
  var parts = url.parse(s3Url);
  if (parts.protocol !== 's3:') {
    console.error("Not a valid S3 URL:", s3Url);
    process.exit(1);
  }
  return {
    bucket: parts.hostname,
    key: parts.path.replace(/^\//, ""),
  };
}
