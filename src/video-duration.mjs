// ABOUTME: Extracts video duration from MP4 file bytes in memory
// ABOUTME: Parses moov/mvhd atom to get duration without external API calls

/**
 * Extract duration from MP4 video bytes
 *
 * MP4 structure: ftyp -> moov -> mvhd (contains duration and timescale)
 * Duration in seconds = duration / timescale
 *
 * @param {ArrayBuffer} buffer - Video file bytes
 * @returns {number|null} Duration in seconds, or null if can't parse
 */
export function getMP4Duration(buffer) {
  try {
    const view = new DataView(buffer);
    const moovOffset = findAtom(view, 0, buffer.byteLength, 'moov');

    if (moovOffset === -1) {
      console.log('[Duration] No moov atom found');
      return null;
    }

    // Read moov atom size
    const moovSize = view.getUint32(moovOffset);
    const moovEnd = moovOffset + moovSize;

    // Find mvhd inside moov (skip moov header: 8 bytes)
    const mvhdOffset = findAtom(view, moovOffset + 8, moovEnd, 'mvhd');

    if (mvhdOffset === -1) {
      console.log('[Duration] No mvhd atom found');
      return null;
    }

    // mvhd structure:
    // 4 bytes: size
    // 4 bytes: 'mvhd'
    // 1 byte: version (0 or 1)
    // 3 bytes: flags
    // If version 0: 4 bytes each for creation_time, modification_time, timescale, duration
    // If version 1: 8 bytes each for creation_time, modification_time, then 4 bytes timescale, 8 bytes duration

    const version = view.getUint8(mvhdOffset + 8);

    let timescale, duration;

    if (version === 0) {
      // Version 0: 32-bit values
      timescale = view.getUint32(mvhdOffset + 20); // offset 8 + 4 + 4 + 4 = 20
      duration = view.getUint32(mvhdOffset + 24);  // offset 20 + 4 = 24
    } else {
      // Version 1: 64-bit times, but timescale still 32-bit
      timescale = view.getUint32(mvhdOffset + 28); // offset 8 + 4 + 8 + 8 = 28
      // Duration is 64-bit, read as two 32-bit values
      const durationHigh = view.getUint32(mvhdOffset + 32);
      const durationLow = view.getUint32(mvhdOffset + 36);
      duration = durationHigh * 0x100000000 + durationLow;
    }

    if (timescale === 0) {
      console.log('[Duration] Invalid timescale (0)');
      return null;
    }

    const durationSeconds = duration / timescale;
    console.log(`[Duration] Parsed: ${durationSeconds.toFixed(2)}s (${duration}/${timescale})`);

    return durationSeconds;
  } catch (error) {
    console.error('[Duration] Parse error:', error);
    return null;
  }
}

/**
 * Find an atom by its 4-character type
 *
 * @param {DataView} view - DataView of the buffer
 * @param {number} start - Start offset to search
 * @param {number} end - End offset to search
 * @param {string} type - 4-character atom type (e.g., 'moov', 'mvhd')
 * @returns {number} Offset of atom, or -1 if not found
 */
function findAtom(view, start, end, type) {
  const typeCode = (type.charCodeAt(0) << 24) |
                   (type.charCodeAt(1) << 16) |
                   (type.charCodeAt(2) << 8) |
                   type.charCodeAt(3);

  let offset = start;

  while (offset < end - 8) {
    const size = view.getUint32(offset);
    const atomType = view.getUint32(offset + 4);

    if (atomType === typeCode) {
      return offset;
    }

    // Handle extended size (size == 1 means 64-bit size follows)
    let atomSize = size;
    if (size === 1 && offset + 16 <= end) {
      const sizeHigh = view.getUint32(offset + 8);
      const sizeLow = view.getUint32(offset + 12);
      atomSize = sizeHigh * 0x100000000 + sizeLow;
    } else if (size === 0) {
      // Size 0 means atom extends to end of file
      atomSize = end - offset;
    }

    if (atomSize < 8) {
      // Invalid atom size, stop searching
      break;
    }

    offset += atomSize;
  }

  return -1;
}

/**
 * Check if video duration exceeds limit
 *
 * @param {ArrayBuffer} buffer - Video file bytes
 * @param {number} maxSeconds - Maximum allowed duration
 * @returns {Object} Result with exceedsLimit boolean and duration
 */
export function checkVideoDurationFromBytes(buffer, maxSeconds = 7) {
  const duration = getMP4Duration(buffer);

  if (duration === null) {
    return {
      exceedsLimit: null,
      duration: null,
      message: 'Could not parse video duration'
    };
  }

  if (duration > maxSeconds) {
    return {
      exceedsLimit: true,
      duration: duration,
      message: `Video duration ${duration.toFixed(1)}s exceeds ${maxSeconds}s limit`
    };
  }

  return {
    exceedsLimit: false,
    duration: duration,
    message: `Video duration ${duration.toFixed(1)}s is within ${maxSeconds}s limit`
  };
}
