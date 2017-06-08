const fs = require('fs')
const md5 = require('md5')

function AfterChunkHashPlugin (options) {
  options = options || {}
  this.manifestJsonName = options.manifestJsonName || 'manifest.json'
}

AfterChunkHashPlugin.prototype.getFileType = str => {
  const parts = str.replace(/\?.*/, '').split('.')

  return parts.pop()
}

AfterChunkHashPlugin.prototype.getNewFileName = (pattern, id, name, hash, ext) => {
  const parts = pattern.split('.')
  const partsWithoutExt = parts.slice(0, -1)

  partsWithoutExt.push(ext)

  return partsWithoutExt
    .join('.')
    .replace('[id]', id)
    .replace('[name]', name)
    .replace(/\[chunkhash(?::\d+)?]/i, hash)
}

AfterChunkHashPlugin.prototype.getHash = (hashString, length) => {
  return (!Number.isNaN(parseInt(length, 10))
    ? (hashString).substring(0, parseInt(length, 10))
    : hashString
  )
}

AfterChunkHashPlugin.prototype.renameAsset = (
  compilation,
  outputPath,
  chunkContents,
  chunkFullPath,
  chunkOriginalName,
  chunkNewName,
  chunkReferenceOriginalName,
  chunkReferenceNewName
) => {
  // replace the old name with the new name in the chunk itself (mainly for map files)
  // remove old file and write new file
  // update webpack compilation output
  chunkContents = chunkContents.replace(
    new RegExp(chunkReferenceOriginalName, 'g'),
    chunkReferenceNewName
  )

  fs.unlinkSync(chunkFullPath)
  fs.writeFileSync(outputPath + '/' + chunkNewName, chunkContents)

  compilation.assets[chunkNewName] = compilation.assets[chunkOriginalName]
  delete compilation.assets[chunkOriginalName]
}

AfterChunkHashPlugin.prototype.findManifestJsName = chunks => {
  for (let i = 0, iLen = chunks.length; i < iLen; i++) {
    if (typeof chunks[i] === 'undefined' || chunks[i].name !== 'manifest') {
      continue
    }

    for (let j = 0, jLen = chunks[i].files.length; j < jLen; j++) {
      if (!chunks[i].files[j].endsWith('.map')) {
        return chunks[i].files[j]
      }
    }
  }

  return null
}

AfterChunkHashPlugin.prototype.updateManifestJson = (manifestJson, searches, find, replace) => {
  searches.forEach(search => {
    if (manifestJson.hasOwnProperty(search)) {
      manifestJson[search] = manifestJson[search].replace(
        new RegExp(find, 'g'),
        replace
      )
    }
  })

  return manifestJson
}

/*
 RegEx output:
 Group 1: 'chunkhash' / 'hash' - we only want to run this on chunk hashes
 Group 2: length of hash - if this doesn't exist, the developer hasn't specified the length
 */

AfterChunkHashPlugin.prototype.apply = function (compiler) {
  compiler.plugin('after-emit', (compilation, callback) => {
    const outputPath = compilation.options.output.path
    const nameRegex = new RegExp(/((?:chunk)?hash):?([\d]+)?/, 'i')

    const fileNamePattern = compilation.options.output.filename
    const fileNameParts = fileNamePattern.match(nameRegex)

    const chunkFileNamePattern = compilation.options.output.chunkFilename
    const chunkFilenameParts = chunkFileNamePattern.match(nameRegex)

    const manifestJsName = this.findManifestJsName(compilation.chunks)

    let manifestJs = null
    let manifestJsMap = null
    let manifestJson = null

    // read the manifest.js file if one exists so we can replace content in it
    if (manifestJsName && fs.existsSync(outputPath + '/' + manifestJsName)) {
      manifestJs = fs.readFileSync(outputPath + '/' + manifestJsName, 'utf-8')

      if (fs.existsSync(outputPath + '/' + manifestJsName + '.map')) {
        manifestJsMap = fs.readFileSync(outputPath + '/' + manifestJsName + '.map', 'utf-8')
      }
    }

    // read the manifest json file so we can update fingerprints
    if (fs.existsSync(outputPath + '/' + this.manifestJsonName)) {
      manifestJson = JSON.parse(fs.readFileSync(outputPath + '/' + this.manifestJsonName, 'utf-8'))
    }

    // for all of the output chunks
    compilation.chunks.forEach(chunk => {
      const isEntryModule = typeof chunk.entryModule !== 'undefined'
      const namePattern = isEntryModule ? fileNamePattern : chunkFileNamePattern
      const nameParts = isEntryModule ? fileNameParts : chunkFilenameParts

      // make sure we're using chunk hashes - otherwise there are no chunks to rehash
      if (nameParts[1] !== 'chunkhash') {
        return
      }

      // for all of the non .map and non manifest files
      chunk.files
        .filter(file => {
          const regexId = new RegExp('\\b' + chunk.id + '\\b', 'gi')
          const regexName = new RegExp('\\b' + chunk.name + '\\b', 'gi')

          return file.endsWith('.js') &&
            !file.startsWith('manifest') &&
            (file.match(regexId) !== null || file.match(regexName) !== null) &&
            fs.existsSync(outputPath + '/' + file)
        })
        .forEach(file => {
          // get contents, extension, new hash and new chunk name
          const chunkFullPath = outputPath + '/' + file
          const chunkMapFullPath = chunkFullPath + '.map'
          const chunkContents = fs.readFileSync(chunkFullPath, 'utf-8')
          const chunkExt = this.getFileType(file)
          const chunkNewHash = this.getHash(md5(chunkContents), nameParts[2])
          const chunkOldHash = this.getHash(chunk.hash, nameParts[2])
          const chunkName = this.getNewFileName(
            namePattern,
            chunk.id,
            chunk.name,
            chunkNewHash,
            chunkExt
          )

          // they're the same name, so same hash. nothing to do
          if (chunkName === file) {
            return
          }

          // rename the original asset
          this.renameAsset(
            compilation,
            outputPath,
            chunkContents,
            chunkFullPath,
            file,
            chunkName,
            file,
            chunkName
          )

          // rename the asset map if it exists
          if (fs.existsSync(chunkMapFullPath)) {
            this.renameAsset(
              compilation,
              outputPath,
              fs.readFileSync(chunkMapFullPath, 'utf-8'),
              chunkMapFullPath,
              file + '.map',
              chunkName + '.map',
              file,
              chunkName
            )
          }

          // replace in manifest.js and manifest.js.map if it exists
          if (manifestJs !== null) {
            manifestJs = manifestJs.replace(
              new RegExp(chunk.id + ':"' + chunkOldHash + '"', 'g'),
              chunk.id + ':"' + chunkNewHash + '"'
            )

            if (manifestJsMap) {
              manifestJsMap = manifestJsMap.replace(
                new RegExp(chunk.id + ':\\\\"' + chunkOldHash + '\\\\"', 'g'),
                chunk.id + ':\\"' + chunkNewHash + '\\"'
              )
            }
          }

          // replace in manifest.json if it exists
          if (manifestJson !== null) {
            manifestJson = this.updateManifestJson(
              manifestJson,
              [chunk.name + '.js', chunk.name + '.js.map'],
              chunkOldHash,
              chunkNewHash
            )
          }
        })
    })

    // write the new manifest.js file
    if (manifestJs !== null) {
      const newManifestName = this.getNewFileName(
        chunkFileNamePattern,
        -1,
        'manifest',
        this.getHash(md5(manifestJs), chunkFilenameParts[2]),
        'js'
      )

      this.renameAsset(
        compilation,
        outputPath,
        manifestJs,
        outputPath + '/' + manifestJsName,
        manifestJsName,
        newManifestName,
        manifestJsName,
        newManifestName
      )

      // rename the manifest.js map if it exists
      if (manifestJsMap !== null) {
        this.renameAsset(
          compilation,
          outputPath,
          manifestJsMap,
          outputPath + '/' + manifestJsName + '.map',
          manifestJsName + '.map',
          newManifestName + '.map',
          manifestJsName,
          newManifestName
        )
      }

      // update in manifest.json if it exists
      if (manifestJson !== null) {
        manifestJson = this.updateManifestJson(
          manifestJson,
          ['manifest.js', 'manifest.js.map'],
          manifestJsName,
          newManifestName
        )
      }
    }

    // write the new manifest.json file
    fs.unlinkSync(outputPath + '/' + this.manifestJsonName)
    fs.writeFileSync(outputPath + '/' + this.manifestJsonName, JSON.stringify(
      manifestJson,
      null,
      2
    ))

    callback()
  })
}

module.exports = AfterChunkHashPlugin
