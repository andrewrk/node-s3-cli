#!/usr/bin/env node

require('graceful-fs');
var minimist = require('minimist');
var osenv = require('osenv');
var filesize = require('file-size');
var mime = require('mime');
var ini = require('ini');
var fs = require('fs');
var path = require('path');
var s3 = require('s3');
var url = require('url');
var http = require('http');
var https = require('https');
var args = minimist(process.argv.slice(2), {
  'default': {
    'config': path.join(osenv.home(), '.s3cfg'),
    'delete-removed': false,
    'max-sockets': 30,
    'insecure': false,
  },
  'boolean': [
    'recursive',
    'deleteRemoved',
    'insecure',
  ],
});

var fns = {
  'sync': cmdSync,
  'ls': cmdList,
  'help': cmdHelp,
  'del': cmdDelete,
  'put': cmdPut,
  'get': cmdGet,
};

var s3UrlRe = /^[sS]3:\/\/(.*?)\/(.*)/;

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
  };
  var syncer = method.call(client, params);
  process.stderr.write("Listing objects...");
  setUpProgress(syncer);
}

function uploadGetS3Params(filePath, stat, callback) {
  console.error("Uploading", filePath);
  callback(null, {
    ContentType: getContentType(filePath),
  });
}

function downloadGetS3Params(filePath, s3Object, callback) {
  console.error("Downloading", filePath);
  callback(null, {});
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
    client.deleteObjects(params);
  }
}

function cmdPut() {
  var source = args._[0];
  var dest = args._[1];
  var parts = parseS3Url(dest);
  var s3Params = {
    Bucket: parts.bucket,
    Key: parts.key,
    ACL: getAcl(),
    ContentType: getContentType(source),
  };
  parseAddHeaders(s3Params);
  var params = {
    localFile: source,
    s3Params: s3Params,
  };
  var uploader = client.uploadFile(params);
  setUpProgress(uploader);
}

function cmdGet() {
  var source = args._[0];
  var dest = args._[1];
  var parts = parseS3Url(source);
  if (!dest) {
    dest = path.basename(source);
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

function cmdHelp() {
  console.log("Usage: s3 (command) (command arguments)");
  console.log("Commands:", Object.keys(fns).join(" "));
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

function getContentType(filename) {
  if (args['default-mime-type']) {
    mime.default_type = args['default-mime-type'];
  }
  if (args['no-guess-mime-type']) {
    return mime.default_type;
  } else {
    return mime.lookup(filename);
  }
}

function getAcl() {
  var acl = null;
  if (args['acl-public'] || args.P) {
    acl = 'public-read';
  } else if (args['acl-private']) {
    acl = 'private';
  }
  return acl;
}

function setUpProgress(o, notBytes, notObjects) {
  var start;
  var sawAnyProgress = false;
  o.on('progress', function() {
    if (o.objectsFound != null && o.progressAmount === 0) {
      process.stderr.write("\rListing objects... " + o.objectsFound + " objects found          ");
      sawAnyProgress = true;
    }
    if (o.progressTotal === 0) return;
    if (!start) {
      sawAnyProgress = true;
      start = new Date();
    }
    var percent = Math.floor(o.progressAmount / o.progressTotal * 100);
    var line = "\rProgress: " +
      o.progressAmount + "/" + o.progressTotal + " " + percent + "%";
    if (!notBytes) {
      var now = new Date();
      var seconds = (now - start) / 1000;
      var bytesPerSec = o.progressAmount / seconds;
      var humanSpeed = filesize(bytesPerSec).human({jedec: true}) + '/s';
      line += " " + humanSpeed;
    }
    line += "                    ";
    process.stderr.write(line);
  });
  o.on('end', function() {
    if (!sawAnyProgress) return;
    process.stderr.write("\n");
  });
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
