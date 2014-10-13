#!/usr/bin/env node

var minimist = require('minimist');
var osenv = require('osenv');
var humanSize = require('human-size');
var ini = require('ini');
var fs = require('fs');
var path = require('path');
var s3 = require('s3');
var url = require('url');
var http = require('http');
var https = require('https');
var argOptions = {
  'default': {
    'config': path.join(osenv.home(), '.s3cfg'),
    'delete-removed': false,
    'max-sockets': 20,
    'region': 'us-east-1',
    'default-mime-type': null,
    'add-header': null,
  },
  'boolean': [
    'recursive',
    'delete-removed',
    'insecure',
    'acl-public',
    'acl-private',
    'no-guess-mime-type',
  ],
  'alias': {
    'P': 'acl-public',
  },
};
var args = minimist(process.argv.slice(2), argOptions);

var fns = {
  'sync': cmdSync,
  'ls': cmdList,
  'help': cmdHelp,
  'del': cmdDelete,
  'put': cmdPut,
  'get': cmdGet,
  'cp': cmdCp,
  'mv': cmdMv,
};
var USAGE_TEXT =
  "Usage: s3-cli (command) (command arguments)\n" +
  "Commands: " + Object.keys(fns).join(" ");
var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;

var s3UrlRe = /^[sS]3:\/\/(.*?)\/(.*)/;
barfOnUnexpectedArgs();

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
  var maxSockets = parseInt(args['max-sockets'], 10);
  http.globalAgent.maxSockets = maxSockets;
  https.globalAgent.maxSockets = maxSockets;
  client = s3.createClient({
    s3Options: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
      sslEnabled: !args.insecure,
      region: args.region,
    },
  });
  var cmd = args._.shift();
  var fn = fns[cmd];
  if (!fn) fn = cmdHelp;
  fn();
});

function cmdSync() {
  expectArgCount(2);
  var source = args._[0];
  var dest = args._[1];

  var sourceS3 = isS3Url(source);
  var destS3 = isS3Url(dest);

  var localDir, s3Url, method;
  var getS3Params;
  var s3Params = {};
  if (sourceS3 && !destS3) {
    localDir = dest;
    s3Url = source;
    method = client.downloadDir;
    getS3Params = downloadGetS3Params;
  } else if (!sourceS3 && destS3) {
    localDir = source;
    s3Url = dest;
    method = client.uploadDir;
    s3Params.ACL = getAcl();
    getS3Params = uploadGetS3Params;
  } else {
    console.error("one target must be from S3, the other must be from local file system.");
    process.exit(1);
  }
  var parts = parseS3Url(s3Url);
  s3Params.Prefix = parts.key;
  s3Params.Bucket = parts.bucket;

  parseAddHeaders(s3Params);

  var params = {
    deleteRemoved: args['delete-removed'],
    getS3Params: getS3Params,
    localDir: localDir,
    s3Params: s3Params,
    defaultContentType: getDefaultContentType(),
  };
  var syncer = method.call(client, params);
  setUpProgress(syncer);
}

function uploadGetS3Params(filePath, stat, callback) {
  //console.error("Uploading", filePath);
  callback(null, {
    ContentType: getContentType(),
  });
}

function downloadGetS3Params(filePath, s3Object, callback) {
  //console.error("Downloading", filePath);
  callback(null, {});
}

function cmdList() {
  expectArgCount(1);
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
  finder.on('error', function(err) {
    console.error("Error: " + err.message);
    process.exit(1);
  });
}

function cmdDelete() {
  expectArgCount(1);
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
    setUpProgress(deleter, true);
  }

  function doDeleteObject() {
    var params = {
      Bucket: parts.bucket,
      Delete: {
        Objects: [
          {
            Key: parts.key,
          },
        ],
      }
    };
    var deleter = client.deleteObjects(params);
    deleter.on('error', function(err) {
      console.error("Error: " + err.message);
      process.exit(1);
    });
  }
}

function cmdPut() {
  expectArgCount(2);
  var source = args._[0];
  var dest = args._[1];
  var parts = parseS3Url(dest);
  if (/\/$/.test(parts.key)) {
    parts.key += path.basename(source);
  }
  var acl = getAcl();
  var s3Params = {
    Bucket: parts.bucket,
    Key: parts.key,
    ACL: acl,
    ContentType: getContentType(),
  };
  parseAddHeaders(s3Params);
  var params = {
    localFile: source,
    s3Params: s3Params,
    defaultContentType: getDefaultContentType(),
  };
  var uploader = client.uploadFile(params);
  var doneText;
  if (acl === 'public-read') {
    var publicUrl = args.insecure ?
      s3.getPublicUrlHttp(parts.bucket, parts.key) :
      s3.getPublicUrl(parts.bucket, parts.key, args.region);
    doneText = "Public URL: " + publicUrl;
  } else {
    doneText = "done";
  }
  setUpProgress(uploader, false, doneText);
}

function cmdGet() {
  expectArgCount(1, 2);
  var source = args._[0];
  var dest = args._[1];
  var parts = parseS3Url(source);
  if (!dest) {
    dest = unixBasename(source);
  } else if (dest[dest.length - 1] === path.sep) {
    dest = path.join(dest, unixBasename(source));
  }

  var params = {
    localFile: dest,
    s3Params: {
      Bucket: parts.bucket,
      Key: parts.key,
    },
  };
  var downloader = client.downloadFile(params);
  setUpProgress(downloader);
}

function cmdCp() {
  expectArgCount(2);
  var source = args._[0];
  var dest = args._[1];
  var sourceParts = parseS3Url(source);
  var destParts = parseS3Url(dest);

  var s3Params = {
    CopySource: sourceParts.bucket + '/' + sourceParts.key,
    Bucket: destParts.bucket,
    Key: destParts.key,
  };

  var copier = client.copyObject(s3Params);
  copier.on('error', function(err) {
    console.error("Error: " + err.message);
    process.exit(1);
  });
}

function cmdMv() {
  expectArgCount(2);
  var source = args._[0];
  var dest = args._[1];
  var sourceParts = parseS3Url(source);
  var destParts = parseS3Url(dest);

  var s3Params = {
    CopySource: sourceParts.bucket + '/' + sourceParts.key,
    Bucket: destParts.bucket,
    Key: destParts.key,
  };

  var mover = client.moveObject(s3Params);
  mover.on('error', function(err) {
    console.error("Error: " + err.message);
    process.exit(1);
  });
}

function cmdHelp() {
  console.log(USAGE_TEXT);
}

function parseS3Url(s3Url) {
  if (!s3Url) {
    console.error("Expected S3 URL argument");
    process.exit(1);
  }
  var match = s3Url.match(s3UrlRe);
  if (!match) {
    console.error("Not a valid S3 URL:", s3Url);
    process.exit(1);
  }
  return {
    bucket: match[1],
    key: match[2],
  };
}

function isS3Url(str) {
  return s3UrlRe.test(str);
}

function getContentType() {
  return args['no-guess-mime-type'] ? null : undefined;
}

function getDefaultContentType() {
  return args['default-mime-type'] || null;
}

function getAcl() {
  var acl = null;
  if (args['acl-public']) {
    acl = 'public-read';
  } else if (args['acl-private']) {
    acl = 'private';
  }
  return acl;
}

function setUpProgress(o, notBytes, doneText) {
  var start = null;
  doneText = doneText || "done";
  var printFn = process.stderr.isTTY ? printProgress : noop;
  printFn();
  var progressInterval = setInterval(printFn, 100);
  o.on('end', function() {
    clearInterval(progressInterval);
    process.stderr.write("\n" + doneText + "\n");
  });
  o.on('error', function(err) {
    clearInterval(progressInterval);
    process.stderr.write("\nError: " + err.message + "\n");
    process.exit(1);
  });

  function printProgress() {
    var percent = Math.floor(o.progressAmount / o.progressTotal * 100);
    var amt = notBytes ? String(o.progressAmount) : fmtBytes(o.progressAmount);
    var total = notBytes ? String(o.progressTotal) : fmtBytes(o.progressTotal);
    var parts = [];
    if (o.filesFound > 0 && !o.doneFindingFiles) {
      parts.push(o.filesFound + " files");
    }
    if (o.objectsFound > 0 && !o.doneFindingObjects) {
      parts.push(o.objectsFound + " objects");
    }
    if (o.deleteTotal > 0) {
      parts.push(o.deleteAmount + "/" + o.deleteTotal + " deleted");
    }
    if (o.progressMd5Amount > 0 && !o.doneMd5) {
      parts.push(fmtBytes(o.progressMd5Amount) + "/" + fmtBytes(o.progressMd5Total) + " MD5");
    }
    if (o.progressTotal > 0) {
      if (!start) start = new Date();
      var part = amt + "/" + total;
      if (!isNaN(percent)) part += " " + percent + "% done";
      parts.push(part);
      if (!notBytes) {
        var now = new Date();
        var seconds = (now - start) / 1000;
        var bytesPerSec = o.progressAmount / seconds;
        var humanSpeed = fmtBytes(bytesPerSec) + '/s';
        parts.push(humanSpeed);
      }
    }
    var line = parts.join(", ");
    process.stderr.clearLine();
    process.stderr.cursorTo(0);
    process.stderr.write(line);
  }
}

function parseAddHeaders(s3Params) {
  var addHeaders = args['add-header'];
  if (addHeaders) {
    if (Array.isArray(addHeaders)) {
      addHeaders.forEach(handleAddHeader);
    } else {
      handleAddHeader(addHeaders);
    }
  }
  function handleAddHeader(header) {
    var match = header.match(/^(.*):\s*(.*)$/);
    if (!match) {
      console.error("Improperly formatted header:", header);
      process.exit(1);
    }
    var headerName = match[1];
    var paramName = headerName.replace(/-/g, '');
    var paramValue = match[2];
    s3Params[paramName] = paramValue;
  }
}

function fmtBytes(byteCount) {
  if (byteCount <= 0) {
    return "0 B";
  } else {
    return humanSize(byteCount, 1);
  }
}

function noop() {}

function barfOnUnexpectedArgs() {
  var validArgs = {'_': true};
  addValid(Object.keys(argOptions.default));
  addValid(Object.keys(argOptions.alias));
  addValid(argOptions.boolean);

  var invalidArgs = [];
  for (var argName in args) {
    if (!validArgs[argName]) {
      invalidArgs.push(argName);
    }
  }

  if (invalidArgs.length) {
    console.error(USAGE_TEXT);
    console.error("Unrecognized option(s): " + invalidArgs.join(", "));
    process.exit(1);
  }

  function addValid(array) {
    array.forEach(function(name) {
      validArgs[name] = true;
    });
  }
}

function expectArgCount(min, max) {
  if (max == null) max = min;
  if (args._.length < min) {
    console.error("Expected at least " + min + " arguments, got " + args._.length);
    process.exit(1);
  }
  if (args._.length > max) {
    console.error("Expected at most " + max + " arguments, got " + args._.length);
    process.exit(1);
  }
}

// copied from Node.js path module for unix only
function unixSplitPath(filename) {
  return splitPathRe.exec(filename).slice(1);
}
function unixBasename(path) {
  return unixSplitPath(path)[2];
}
