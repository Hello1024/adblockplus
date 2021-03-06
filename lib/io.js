/*
 * This file is part of Adblock Plus <http://adblockplus.org/>,
 * Copyright (C) 2006-2014 Eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * @fileOverview Module containing file I/O helpers.
 */

let {Services} = Cu.import("resource://gre/modules/Services.jsm", null);
let {FileUtils} = Cu.import("resource://gre/modules/FileUtils.jsm", null);
let {OS} = Cu.import("resource://gre/modules/osfile.jsm", null);
let {Task} = Cu.import("resource://gre/modules/Task.jsm", null);

let {TimeLine} = require("timeline");
let {Utils} = require("utils");

const BUFFER_SIZE = 0x8000;  // 32kB

let IO = exports.IO =
{
  /**
   * Retrieves the platform-dependent line break string.
   */
  get lineBreak()
  {
    let lineBreak = (Services.appinfo.OS == "WINNT" ? "\r\n" : "\n");
    delete IO.lineBreak;
    IO.__defineGetter__("lineBreak", function() lineBreak);
    return IO.lineBreak;
  },

  /**
   * Tries to interpret a file path as an absolute path or a path relative to
   * user's profile. Returns a file or null on failure.
   */
  resolveFilePath: function(/**String*/ path) /**nsIFile*/
  {
    if (!path)
      return null;

    try {
      // Assume an absolute path first
      return new FileUtils.File(path);
    } catch (e) {}

    try {
      // Try relative path now
      return FileUtils.getFile("ProfD", path.split("/"));
    } catch (e) {}

    return null;
  },

  /**
   * Reads strings from a file asynchronously, calls listener.process() with
   * each line read and with a null parameter once the read operation is done.
   * The callback will be called when the operation is done.
   */
  readFromFile: function(/**nsIFile*/ file, /**Boolean*/ decode, /**Object*/ listener, /**Function*/ callback, /**String*/ timeLineID)
  {
    try
    {
      let processing = false;
      let buffer = "";
      let loaded = false;
      let error = null;

      let onProgress = function(data)
      {
        if (timeLineID)
        {
          TimeLine.asyncStart(timeLineID);
        }

        let index = (processing ? -1 : Math.max(data.lastIndexOf("\n"), data.lastIndexOf("\r")));
        if (index >= 0)
        {
          // Protect against reentrance in case the listener processes events.
          processing = true;
          try
          {
            let oldBuffer = buffer;
            buffer = data.substr(index + 1);
            data = data.substr(0, index + 1);
            let lines = data.split(/[\r\n]+/);
            lines.pop();
            lines[0] = oldBuffer + lines[0];
            for (let i = 0; i < lines.length; i++)
              listener.process(lines[i]);
          }
          finally
          {
            processing = false;
            data = buffer;
            buffer = "";
            onProgress(data);

            if (loaded)
            {
              loaded = false;
              onSuccess();
            }

            if (error)
            {
              let param = error;
              error = null;
              onError(param);
            }
          }
        }
        else
          buffer += data;

        if (timeLineID)
        {
          TimeLine.asyncEnd(timeLineID);
        }
      };

      let onSuccess = function()
      {
        if (processing)
        {
          // Still processing data, delay processing this event.
          loaded = true;
          return;
        }

        if (timeLineID)
        {
          TimeLine.asyncStart(timeLineID);
        }

        if (buffer !== "")
          listener.process(buffer);
        listener.process(null);

        if (timeLineID)
        {
          TimeLine.asyncEnd(timeLineID);
          TimeLine.asyncDone(timeLineID);
        }

        callback(null);
      };

      let onError = function(e)
      {
        if (processing)
        {
          // Still processing data, delay processing this event.
          error = e;
          return;
        }

        callback(e);

        if (timeLineID)
        {
          TimeLine.asyncDone(timeLineID);
        }
      };

      let decoder = new TextDecoder();
      let array = new Uint8Array(BUFFER_SIZE);
      Task.spawn(function()
      {
        let f = yield OS.File.open(file.path, {read: true});
        let numBytes;
        do
        {
          numBytes = yield f.readTo(array);
          if (numBytes)
          {
            let data = decoder.decode(numBytes == BUFFER_SIZE ?
                                      array :
                                      array.subarray(0, numBytes), {stream: true});
            onProgress(data);
          }
        } while (numBytes);

        yield f.close();
      }.bind(this)).then(onSuccess, onError);
    }
    catch (e)
    {
      callback(e);
    }
  },

  /**
   * Writes string data to a file asynchronously, optionally encodes it into
   * UTF-8 first. The callback will be called when the write operation is done.
   */
  writeToFile: function(/**nsIFile*/ file, /**Boolean*/ encode, /**Iterator*/ data, /**Function*/ callback, /**String*/ timeLineID)
  {
    try
    {
      let encoder = new TextEncoder();

      Task.spawn(function()
      {
        // This mimics OS.File.writeAtomic() but writes in chunks.
        let tmpPath = file.path + ".tmp";
        let f = yield OS.File.open(tmpPath, {write: true, truncate: true});

        let buf = [];
        let bufLen = 0;
        let lineBreak = this.lineBreak;

        function writeChunk()
        {
          let array = encoder.encode(buf.join(lineBreak) + lineBreak);
          buf = [];
          bufLen = 0;
          return f.write(array);
        }

        for (let line in data)
        {
          buf.push(line);
          bufLen += line.length;
          if (bufLen >= BUFFER_SIZE)
            yield writeChunk();
        }

        if (bufLen)
          yield writeChunk();

        // OS.File.flush() isn't exposed prior to Gecko 27, see bug 912457.
        if (typeof f.flush == "function")
          yield f.flush();
        yield f.close();
        yield OS.File.move(tmpPath, file.path, {noCopy: true});
      }.bind(this)).then(callback.bind(null, null), callback);
    }
    catch (e)
    {
      callback(e);
    }
  },

  /**
   * Copies a file asynchronously. The callback will be called when the copy
   * operation is done.
   */
  copyFile: function(/**nsIFile*/ fromFile, /**nsIFile*/ toFile, /**Function*/ callback)
  {
    try
    {
      let promise = OS.File.copy(fromFile.path, toFile.path);
      promise.then(callback.bind(null, null), callback);
    }
    catch (e)
    {
      callback(e);
    }
  },

  /**
   * Renames a file within the same directory, will call callback when done.
   */
  renameFile: function(/**nsIFile*/ fromFile, /**String*/ newName, /**Function*/ callback)
  {
    try
    {
      toFile = fromFile.clone();
      toFile.leafName = newName;
      let promise = OS.File.move(fromFile.path, toFile.path);
      promise.then(callback.bind(null, null), callback);
    }
    catch(e)
    {
      callback(e);
    }
  },

  /**
   * Removes a file, will call callback when done.
   */
  removeFile: function(/**nsIFile*/ file, /**Function*/ callback)
  {
    try
    {
      let promise = OS.File.remove(file.path);
      promise.then(callback.bind(null, null), callback);
    }
    catch(e)
    {
      callback(e);
    }
  },

  /**
   * Gets file information such as whether the file exists.
   */
  statFile: function(/**nsIFile*/ file, /**Function*/ callback)
  {
    try
    {
      let promise = OS.File.stat(file.path);
      promise.then(function onSuccess(info)
      {
        callback(null, {
          exists: true,
          isDirectory: info.isDir,
          isFile: !info.isDir,
          lastModified: info.lastModificationDate.getTime()
        });
      }, function onError(e)
      {
        if (e.becauseNoSuchFile)
        {
          callback(null, {
            exists: false,
            isDirectory: false,
            isFile: false,
            lastModified: 0
          });
        }
        else
          callback(e);
      });
    }
    catch(e)
    {
      callback(e);
    }
  }
}
