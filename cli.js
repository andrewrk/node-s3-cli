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
    'config': path.join(osenv.home(), '.s3cfg'),
    'delete-removed': false,
  },
  'boolean': ['recursive', 'deleteRemoved'],
});

var fns = {
  'sync': cmdSync,
  'ls': cmdList,
  'help': cmdHelp,
  'del': cmdDelete,
};

var isS3UrlRe = /^[sS]3:\/\//;

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
  var source = args._[0];
  var dest = args._[1];

  var sourceS3 = isS3Url(source);
  var destS3 = isS3Url(dest);

  var localDir, s3Url, method;
  if (sourceS3 && !destS3) {
    localDir = dest;
    s3Url = source;
    method = client.downloadDir;
  } else if (!sourceS3 && destS3) {
    localDir = source;
    s3Url = dest;
    method = client.uploadDir;
  } else {
    console.error("one target must be from S3, the other must be from local file system.");
    process.exit(1);
  }
  var parts = parseS3Url(s3Url);
  var params = {
    deleteRemoved: args['delete-removed'],
    localDir: localDir,
    s3Params: {
      Prefix: parts.key,
      Bucket: parts.bucket,
    },
  };
  var syncer = method.call(client, params);
  var haveProgress = false;
  console.error("fetching file list");
  syncer.on('progress', function() {
    process.stderr.write("\rProgress: " + syncer.progressAmount + "/" + syncer.progressTotal +
      "                    ");
  });
  syncer.on('end', function() {
    process.stderr.write("\n");
  });
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

function cmdDelete() {
  var parts = parseS3Url(args._[0]);
  if (args.recursive) {
    doDeleteDir();
  } else {
    doDeleteObject();
  }

  function doDeleteDir() {
    var params = {
      Bucket: parts.bucket,
      Prefix: parts.key,
    };
    var deleter = client.deleteDir(params);
    deleter.on('progress', function() {
      process.stderr.write("\rProgress: " + deleter.progressAmount + "/" + deleter.progressTotal +
      "                    ");
    });
    deleter.on('end', function() {
      process.stderr.write("\n");
    });
  }

  function doDeleteObject() {
    var params = {
      Bucket: parts.bucket,
      Key: parts.key,
    };
    client.deleteObjects(params);
  }
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

function isS3Url(str) {
  return isS3UrlRe.test(str);
}
