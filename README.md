# s3 cli

Command line utility frontend to [node-s3-client](https://github.com/andrewrk/node-s3-client).

## Features

 * Compatible with [s3cmd](https://github.com/s3tools/s3cmd)'s config file
 * list directories
 * sync a local directory to S3 and vice versa
 * delete a directory on S3

## Install

`sudo npm install -g s3-cli`

## Documentation

### ls

Lists S3 objects.

Example:

```
s3-cli ls [--recursive] s3://mybucketname/this/is/the/key/
```

### sync

#### Sync a local directory to S3

Example:

```
s3-cli sync [--delete-removed] /path/to/folder/ s3://bucket/key/on/s3/
```

#### Sync a directory on S3 to disk

Example:

```
s3-cli sync [--delete-removed] s3://bucket/key/on/s3/ /path/to/folder/
```

### del

Deletes an object or a directory on S3.

Example:

```
s3-cli del [--recursive] s3://bucket/key/on/s3/
```
