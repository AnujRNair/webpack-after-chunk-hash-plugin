# Webpack After Chunk Hash Plugin

A webpack plugin to rename chunks to incorporate their true hashes, after the chunks have been emitted, regardless of their import order, or any other non deterministic state.

### Jump to:
* [Usage](#usage)
* [Configuration Options Object](#configuration-options-object)

## Problem

After setting up my webpack config file to chunk my application and product a manifest.js file via the CommonChunksPlugin,
I was finding that the hashes in the filenames generated in the manifest.js file were different to the ones webpack was trying to call.
[Other developers have been running into the same problem](https://github.com/webpack/webpack/issues/959).

### Setup

My simplified webpack config:
```js
module.exports = {
  entry: 'index.js',
  output: {
    path: path.resolve(__dirname, 'public', 'dist'),
    
    // all chunks should be fingerprinted with their hash
    filename: '[name].[chunkhash:7].js',
    chunkFilename: '[name].[chunkhash:7].js'
  },
  
  resolve: {
    extensions: [],
    ...
  },
  
  module: {
    rules: [
      ...
    ]
  },
  
  plugins: [
    // make sure we're using MD5 to generate hashes
    new WebpackMd5Hash(),
    
    // put all node modules into a vendor chunk
    new webpack.optimize.CommonsChunkPlugin({
      name: 'vendor',
      minChunks: function(module) {
        return /node_modules/.test(module.resource);
      }
    }),
    
    // and separate webpack manifest into separate file further, so we can include it directly on the HTML page
    new webpack.optimize.CommonsChunkPlugin('manifest')
  ]
}
```

### Producing the issue

When running webpack, I was getting the following output [1]:
```
chunk-details.d86abc7.js     708 kB  1  [emitted]  [big]  chunk-details
   chunk-home.3ba4f8b.js     296 kB  2  [emitted]  [big]  chunk-home
       vendor.eb1350c.js    2.97 MB  3  [emitted]  [big]  vendor
     manifest.d41d8cd.js    6.66 kB  4  [emitted]         manifest
```

On inspecting how webpack is producing the chunk files, I see the following:
```
...
module.exports = exports['default'];

/***/ }),
/* 2 */,
/* 3 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

// further down in the code ...

var _someModule = __webpack_require__(2)
```

Here, webpack is de-duplicating my imports so the same module isn't bundled into the chunks multiple times. 

When webpack needs a reference to this module, it will call it using `__webpack_require__(2)` or `__webpack_require__(3)`

**This is where our bug comes in** - when changing some code in a chunk, and rerunning webpack, I was still seeing the same output for the non modified chunks as shown in [1] (which is expected), however, the webpack output has now changed slightly:
```
...
module.exports = exports['default'];

/***/ }),
/* 2 */,
/* 3 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

// further down in the code ...

var _someModule = __webpack_require__(3)  // this require number is different!
```

Although webpack is still trying to get a reference to the module I want, it is using a different module chunk id to try and do so.

### Why is this happening?

When computing chunks' hashes, webpack does so *only on the contents of the chunk*, hence if nothing changes in that chunk, the same chunk hash should be produced.

When webpack compiled all of the necessary modules into a single file, it seems to do so in a non deterministic way, maybe because it is trying to promote the most used chunks to the top for optimization purposes. 
This means that chunks which haven't changed will still be trying to reference the module using `__webpack_require__(2)` whereas the newly changed chunk may try and access it as `__webpack_require__(3)`.
Since a chunk only has one module chunk id, one of those calls will fail.

### How does this relate to the bug above?

Since hashes are only computed based on the contents of the module, and not the final file created, this means that even though the new chunk webpack generates will correctly try referencing `__webpack_require__(3)`, it will have the same name final name as what was output before. To summarize:

| Compilation | File generated    | Webpack call             | 
| :---------: | :---------------: | :----------------------: |
| 1           | vendor.eb1350c.js | `__webpack_require__(2)` |
| 2           | vendor.eb1350c.js | `__webpack_require__(3)` |

Due to caching, our browser won't try downloading the changed file due to it having the same name. Hence our call to the required chunk file will fail - it's still using the file which is trying to search for `2` instead of `3` 
 
### `HashedModuleIdsPlugin` to the rescue?

The `webpack.HashedModuleIdsPlugin` replaces the module chunk ids with a short string, hence always calling the webpack module using the same string. Our webpack code now looks like the following:
```
module.exports = exports['default'];

/***/ }),

/***/ "V7Hl":
/***/ (function(module, exports) {

"use strict";

// further down in the code ...

var _someModule = __webpack_require__("V7Hl")
```

This seems to work in most use cases, but not all. 
Sometimes untouched chunks will still try referencing an old hashed module id, whereas the changed chunk will reference the new one. That means we still run into the same problem as before.

### `AfterChunkHashPlugin`

AfterChunkHashPlugin waits until the final chunks have all been output and written to disk, and then recomputes the hashes of the files created, and updates all references accordingly.

It's not an ideal solution given we're updating files which have already been written to disk, but I've been using this in production for a couple of months now on a large site, and it has seemed to solve our issue of non deterministic hashing.

This forces the fingerprints of the files created to update, and hence the browser cache is bust, and is forced to download the latest file which has the updated references.

## Usage

Install using `npm` or `yarn`
```js
npm install webpack-after-chunk-hash-plugin --save-dev
yarn add webpack-after-chunk-hash-plugin --dev
```

In your `webpack.config.js` file:

```js
const AfterChunkHashPlugin = require('webpack-after-chunk-hash-plugin');

module.exports = {
  ...
  plugins: [
    new AfterChunkHashPlugin(opts)
  ]
}
```

## Configuration Options Object

The AfterChunkHashPlugin accepts an object of options with the following attributes:

```js
new AfterChunkHashPlugin({
  manifestJsonName: 'manifest.json'
})
```

* `manifestJsonName` the name of the manifest json file you are using - the plugin will rename the references in this file for you too.
