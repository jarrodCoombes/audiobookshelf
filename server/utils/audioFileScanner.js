const Path = require('path')
const Logger = require('../Logger')
const prober = require('./prober')

const ImageCodecs = ['mjpeg', 'jpeg', 'png']

function getDefaultAudioStream(audioStreams) {
  if (audioStreams.length === 1) return audioStreams[0]
  var defaultStream = audioStreams.find(a => a.is_default)
  if (!defaultStream) return audioStreams[0]
  return defaultStream
}

async function scan(path, verbose = false) {
  Logger.debug(`Scanning path "${path}"`)
  var probeData = await prober(path, verbose)
  if (!probeData || !probeData.audio_streams || !probeData.audio_streams.length) {
    return {
      error: 'Invalid audio file'
    }
  }
  if (!probeData.duration || !probeData.size) {
    return {
      error: 'Invalid duration or size'
    }
  }
  var audioStream = getDefaultAudioStream(probeData.audio_streams)

  const finalData = {
    format: probeData.format,
    duration: probeData.duration,
    size: probeData.size,
    bit_rate: audioStream.bit_rate || probeData.bit_rate,
    codec: audioStream.codec,
    time_base: audioStream.time_base,
    language: audioStream.language,
    channel_layout: audioStream.channel_layout,
    channels: audioStream.channels,
    sample_rate: audioStream.sample_rate,
    chapters: probeData.chapters || []
  }

  var hasCoverArt = probeData.video_stream ? ImageCodecs.includes(probeData.video_stream.codec) : false
  if (hasCoverArt) {
    finalData.embedded_cover_art = probeData.video_stream.codec
  }

  for (const key in probeData) {
    if (probeData[key] && key.startsWith('file_tag')) {
      finalData[key] = probeData[key]
    }
  }

  if (finalData.file_tag_track) {
    var track = finalData.file_tag_track
    var trackParts = track.split('/').map(part => Number(part))
    if (trackParts.length > 0) {
      finalData.trackNumber = trackParts[0]
    }
    if (trackParts.length > 1) {
      finalData.trackTotal = trackParts[1]
    }
  }

  if (verbose && probeData.rawTags) {
    finalData.rawTags = probeData.rawTags
  }

  return finalData
}
module.exports.scan = scan


function isNumber(val) {
  return !isNaN(val) && val !== null
}

function getTrackNumberFromMeta(scanData) {
  return !isNaN(scanData.trackNumber) && scanData.trackNumber !== null ? Math.trunc(Number(scanData.trackNumber)) : null
}

function getTrackNumberFromFilename(title, author, series, publishYear, filename) {
  var partbasename = Path.basename(filename, Path.extname(filename))

  // Remove title, author, series, and publishYear from filename if there
  if (title) partbasename = partbasename.replace(title, '')
  if (author) partbasename = partbasename.replace(author, '')
  if (series) partbasename = partbasename.replace(series, '')
  if (publishYear) partbasename = partbasename.replace(publishYear)

  // Remove eg. "disc 1" from path
  partbasename = partbasename.replace(/\bdisc \d\d?\b/i, '')

  // Remove "cd01" or "cd 01" from path
  partbasename = partbasename.replace(/\bcd ?\d\d?\b/i, '')

  var numbersinpath = partbasename.match(/\d{1,4}/g)
  if (!numbersinpath) return null

  var number = numbersinpath.length ? parseInt(numbersinpath[0]) : null
  return number
}

function getCdNumberFromFilename(title, author, series, publishYear, filename) {
  var partbasename = Path.basename(filename, Path.extname(filename))

  // Remove title, author, series, and publishYear from filename if there
  if (title) partbasename = partbasename.replace(title, '')
  if (author) partbasename = partbasename.replace(author, '')
  if (series) partbasename = partbasename.replace(series, '')
  if (publishYear) partbasename = partbasename.replace(publishYear)

  var cdNumber = null

  var cdmatch = partbasename.match(/\b(disc|cd) ?(\d\d?)\b/i)
  if (cdmatch && cdmatch.length > 2 && cdmatch[2]) {
    if (!isNaN(cdmatch[2])) {
      cdNumber = Number(cdmatch[2])
    }
  }

  return cdNumber
}

async function scanAudioFiles(audiobook, newAudioFiles) {
  if (!newAudioFiles || !newAudioFiles.length) {
    Logger.error('[AudioFileScanner] Scan Audio Files no new files', audiobook.title)
    return
  }

  Logger.debug('[AudioFileScanner] Scanning audio files')

  var tracks = []
  var numDuplicateTracks = 0
  var numInvalidTracks = 0

  for (let i = 0; i < newAudioFiles.length; i++) {
    var audioFile = newAudioFiles[i]
    var scanData = await scan(audioFile.fullPath)
    if (!scanData || scanData.error) {
      Logger.error('[AudioFileScanner] Scan failed for', audioFile.path)
      continue;
    }

    var trackNumFromMeta = getTrackNumberFromMeta(scanData)
    var book = audiobook.book || {}

    var trackNumFromFilename = getTrackNumberFromFilename(book.title, book.author, book.series, book.publishYear, audioFile.filename)

    var cdNumFromFilename = getCdNumberFromFilename(book.title, book.author, book.series, book.publishYear, audioFile.filename)

    // IF CD num was found but no track num - USE cd num as track num
    if (!trackNumFromFilename && cdNumFromFilename) {
      trackNumFromFilename = cdNumFromFilename
      cdNumFromFilename = null
    }

    var audioFileObj = {
      ino: audioFile.ino,
      filename: audioFile.filename,
      path: audioFile.path,
      fullPath: audioFile.fullPath,
      ext: audioFile.ext,
      ...scanData,
      trackNumFromMeta,
      trackNumFromFilename,
      cdNumFromFilename
    }
    var audioFile = audiobook.addAudioFile(audioFileObj)

    var trackNumber = 1
    if (newAudioFiles.length > 1) {
      trackNumber = isNumber(trackNumFromMeta) ? trackNumFromMeta : trackNumFromFilename
      if (trackNumber === null) {
        Logger.debug('[AudioFileScanner] Invalid track number for', audioFile.filename)
        audioFile.invalid = true
        audioFile.error = 'Failed to get track number'
        numInvalidTracks++
        continue;
      }
    }

    if (tracks.find(t => t.index === trackNumber)) {
      // Logger.debug('[AudioFileScanner] Duplicate track number for', audioFile.filename)
      audioFile.invalid = true
      audioFile.error = 'Duplicate track number'
      numDuplicateTracks++
      continue;
    }

    audioFile.index = trackNumber
    tracks.push(audioFile)
  }

  if (!tracks.length) {
    Logger.warn('[AudioFileScanner] No Tracks for audiobook', audiobook.id)
    return
  }

  if (numDuplicateTracks > 0) {
    Logger.warn(`[AudioFileScanner] ${numDuplicateTracks} Duplicate tracks for "${audiobook.title}"`)
  }
  if (numInvalidTracks > 0) {
    Logger.error(`[AudioFileScanner] ${numDuplicateTracks} Invalid tracks for "${audiobook.title}"`)
  }

  tracks.sort((a, b) => a.index - b.index)

  audiobook.audioFiles.sort((a, b) => {
    var aNum = isNumber(a.trackNumFromMeta) ? a.trackNumFromMeta : isNumber(a.trackNumFromFilename) ? a.trackNumFromFilename : 0
    var bNum = isNumber(b.trackNumFromMeta) ? b.trackNumFromMeta : isNumber(b.trackNumFromFilename) ? b.trackNumFromFilename : 0
    return aNum - bNum
  })

  // If first index is 0, increment all by 1
  if (tracks[0].index === 0) {
    tracks = tracks.map(t => {
      t.index += 1
      return t
    })
  }

  var hasTracksAlready = audiobook.tracks.length
  tracks.forEach((track) => {
    audiobook.addTrack(track)
  })
  if (hasTracksAlready) {
    audiobook.tracks.sort((a, b) => a.index - b.index)
  }
}
module.exports.scanAudioFiles = scanAudioFiles


async function rescanAudioFiles(audiobook) {
  var audioFiles = audiobook.audioFiles
  var updates = 0

  for (let i = 0; i < audioFiles.length; i++) {
    var audioFile = audioFiles[i]
    var scanData = await scan(audioFile.fullPath)
    if (!scanData || scanData.error) {
      Logger.error('[AudioFileScanner] Scan failed for', audioFile.path)
      // audiobook.invalidAudioFiles.push(parts[i])
      continue;
    }

    var trackNumFromMeta = getTrackNumberFromMeta(scanData)
    var book = audiobook.book || {}

    var trackNumFromFilename = getTrackNumberFromFilename(book.title, book.author, book.series, book.publishYear, audioFile.filename)

    var cdNumFromFilename = getCdNumberFromFilename(book.title, book.author, book.series, book.publishYear, audioFile.filename)

    // IF CD num was found but no track num - USE cd num as track num
    if (!trackNumFromFilename && cdNumFromFilename) {
      trackNumFromFilename = cdNumFromFilename
      cdNumFromFilename = null
    }

    var metadataUpdate = {
      ...scanData,
      trackNumFromMeta,
      trackNumFromFilename,
      cdNumFromFilename
    }
    var hasUpdates = audioFile.updateMetadata(metadataUpdate)
    if (hasUpdates) {
      // Sync audio track with audio file
      var matchingAudioTrack = audiobook.tracks.find(t => t.ino === audioFile.ino)
      if (matchingAudioTrack) {
        matchingAudioTrack.syncMetadata(audioFile)
      } else if (!audioFile.exclude) { // If audio file is not excluded then it should have an audio track

        // Fallback to checking path
        matchingAudioTrack = audiobook.tracks.find(t => t.path === audioFile.path)
        if (matchingAudioTrack) {
          Logger.error(`[AudioFileScanner] Audio File mismatch ino with audio track "${audioFile.filename}"`)
          matchingAudioTrack.ino = audioFile.ino
          matchingAudioTrack.syncMetadata(audioFile)
        } else {
          Logger.error(`[AudioFileScanner] Audio File has no matching Track ${audioFile.filename} for "${audiobook.title}"`)

          // Exclude audio file to prevent further errors
          // audioFile.exclude = true
        }
      }
      updates++
    }
  }

  return updates
}
module.exports.rescanAudioFiles = rescanAudioFiles

async function scanTrackNumbers(audiobook) {
  var tracks = audiobook.tracks || []
  var scannedTrackNumData = []
  for (let i = 0; i < tracks.length; i++) {
    var track = tracks[i]
    var scanData = await scan(track.fullPath, true)

    var trackNumFromMeta = getTrackNumberFromMeta(scanData)
    var book = audiobook.book || {}
    var trackNumFromFilename = getTrackNumberFromFilename(book.title, book.author, book.series, book.publishYear, track.filename)
    Logger.info(`[AudioFileScanner] Track # for "${track.filename}", Metadata: "${trackNumFromMeta}", Filename: "${trackNumFromFilename}", Current: "${track.index}"`)
    scannedTrackNumData.push({
      filename: track.filename,
      currentTrackNum: track.index,
      trackNumFromFilename,
      trackNumFromMeta,
      scanDataTrackNum: scanData.file_tag_track,
      rawTags: scanData.rawTags || null
    })
  }
  return scannedTrackNumData
}
module.exports.scanTrackNumbers = scanTrackNumbers