/*
 *  Copyright 2016 Shaunak Kishore (kshaunak "at" gmail.com)
 *
 *  This file is part of Inkstone.
 *
 *  Inkstone is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  Inkstone is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with Inkstone.  If not, see <http://www.gnu.org/licenses/>.
 */

import {CharacterData, assetForCharacter} from '/lib/characters';

const kListColumns = [
  'simplified', 'traditional', 'numbered', 'pinyin', 'definition'];

// Cache for bundled character_v2 asset files (parsed from NDJSON)
const kCharacterCache = {};

// onAssetsLoaded is a callback that is executed when all required assets,
// such as the character data files, are saved to the asset store.
let onAssetsLoaded = null;
const kLoaded = new Promise((resolve, _) => onAssetsLoaded = resolve);

const kStartup = new Promise((resolve, _) => Meteor.startup(resolve));

const base64 = {
  decode: (uri) => {
    const d = (ch) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2);
    return decodeURIComponent(Array.from(atob(uri)).map(d).join(''));
  },
  encode: (data) => {
    return btoa(encodeURIComponent(data).replace(
        /%([0-9A-F]{2})/g, (match, x) => String.fromCharCode('0x' + x)));
  },
};

// Input: a target filename and the data to download to it.
// Output: a Promise that resolves to a description of where to find the file.
const download = (filename, data) => {
  return kStartup.then(() => new Promise((resolve) => {
    const link = document.createElement('a');
    link.href = `data:text/plain;charset:utf-8;base64,${base64.encode(data)}`;
    link.download = filename;
    link.click();
    resolve('Downloads folder.');
  }));
}

const isImportedAsset = (asset) => {
  return asset.startsWith('characters/') || asset.startsWith('lists/s/');
}

// Input: a path to an asset in www/assets
// Output: a Promise that resolves to the String contents of that file.
// Imported assets (user data) are stored in localStorage; bundled assets
// are fetched from the app bundle via fetch().
const readAsset = (path) => {
  const blocker = isImportedAsset(path) ? kLoaded : kStartup;
  return blocker.then(() => {
    // Check localStorage first for user-imported assets
    if (isImportedAsset(path)) {
      const stored = localStorage.getItem('asset:' + path);
      if (stored !== null) return stored;
    }
    return fetch(`/assets/${path}`).then((r) => {
      if (!r.ok) throw new Error(`Asset not found: ${path}`);
      return r.text();
    });
  });
}

// Input: a single Chinese character
// Output: a Promise that resolves to that character's data, with all of the
//         data required in writeCharacter, below
const readCharacter = (character) => {
  if (!character) return Promise.reject('No character provided.');
  // First try to read from bundled characters_v2 assets (NDJSON format).
  const asset = assetForCharacter(character);
  if (!kCharacterCache[asset]) {
    kCharacterCache[asset] = readAsset(asset).then((data) => {
      const map = {};
      data.split('\n').filter((x) => x).forEach((line) => {
        const parsed = JSON.parse(line);
        map[parsed.character] = parsed;
      });
      return map;
    }).catch(() => null);
  }
  return kCharacterCache[asset].then((map) => {
    if (map && map[character]) return map[character];
    throw new Error(`Character ${character} not found in bundled data (${asset})`);
  });
}

// Input: an item, which includes a word and a list of lists it appears in
// Output: a Promise that resolves to the item data Object for that item:
//   - characters: a list of character data Objects for each of its characters
//   - definition: the definition of this word
//   - numbered: the pronunciation of this word in the form `Zhong1wen2`.
//   - pinyin: the pronunciation of this word
//   - simplified: the word in simplified characters
//   - traditional: the word in traditional characters
//   - word: the word in the given character set
const readItem = (item, charset) => {
  if (!item || !item.word || item.lists.length === 0) {
    return Promise.reject(new Error(item));
  }
  return Promise.all([
    readList(item.lists[0]),
    Promise.all(Array.from(item.word).map(readCharacter)),
    kRadicals,
  ]).then((resolutions) => {
    const [list, characters, radicals] = resolutions;
    const entries = list.filter((x) => x[charset] === item.word);
    if (entries.length === 0) throw new Error(`Entry not found: ${item.word}`);
    const entry = entries[0];
    entry.characters = characters;
    entry.word = item.word;
    const radical = radicals[item.word];
    if (radical && entry.characters.length === 1) {
      const base = entry.definition || entry.characters[0].definition || '';
      entry.definition = `${base}${base ? '; ' : ''}radical ${radical}`;
    }
    return entry;
  });
}

// Input: the name of a list
// Output: a Promise that resolves to a list of items that appear in the list,
//         each with all the readItem fields except `characters` and `word`
const readList = (list) => {
  return Promise.all([
    readAsset(`lists/${list}.list`),
    kCharacters,
  ]).then((resolutions) => {
    const [data, characters] = resolutions;
    const result = [];
    data.split('\n').forEach((line) => {
      const values = line.split('\t');
      if (values.length !== kListColumns.length) return;
      const row = {};
      kListColumns.forEach((column, i) => row[column] = values[i]);
      const words = row.simplified + row.traditional;
      if (!_.all(words, (x) => characters[x])) return;
      result.push(row);
    });
    return result;
  });
}

// Input: a path to an asset in www/assets
// Output: a Promise that resolves when that asset is removed from localStorage
const removeAsset = (path) => {
  if (!isImportedAsset(path)) {
    return Promise.reject(`Tried to remove static asset: ${path}`);
  }
  return kStartup.then(() => {
    localStorage.removeItem('asset:' + path);
  });
}

// Deletes the given list and resolves when it is removed.
const removeList = (list) => removeAsset(`lists/${list}.list`);

// Input: a path to an asset in www/assets, and data to write.
// Output: a Promise that resolves to true if the write is successful.
// User-imported assets are stored in localStorage.
const writeAsset = (path, data) => {
  if (!isImportedAsset(path)) {
    return Promise.reject(`Tried to write static asset: ${path}`);
  }
  return kStartup.then(() => {
    localStorage.setItem('asset:' + path, data);
    return true;
  });
}

// Input: an character Object (with format defined by the Match expression)
// Output: a promise that resolves to true when it is saved to the asset store
const writeCharacter = (data) => {
  check(data, CharacterData);
  const path = `characters/${data.character.codePointAt(0)}`;
  return writeAsset(path, JSON.stringify(data));
}

// Input: a list of list-item objects with all the list column keys
// Output: a promise that resolves to a dict with the following keys:
//    - count: the total number of new words included in the list
//    - missing: the set of characters in list without stroke data
//
// WARNING: If items is an empty set, the list will not actually be written.
// This is a failure case that should be handled by the caller.
const writeList = (list, items) => {
  return kCharacters.then((characters) => {
    const result = {count: 0, missing: {}};
    const rows = [];
    for (let item of items) {
      const fields = kListColumns.map((column) => item[column]);
      const missing = kListColumns.filter((column) => !item[column]);
      if (missing.length > 0) {
        return Promise.reject(`Malformatted row: ${fields.join(', ')}. ` +
                              `Missing data for: ${missing.join(', ')}.`);
      }
      const words = item.simplified + item.traditional;
      if (!_.all(words, (x) => characters[x])) {
        Array.from(words).forEach(
            (x) => { if (!characters[x]) result.missing[x] = true; });
        continue;
      }
      const line = fields.join('\t');
      if (line.split('\t').length !== fields.length) {
        return Promise.reject(`Row contains tabs: ${fields.join(', ')}.`);
      }
      result.count += 1;
      rows.push(line);
    }
    if (rows.length === 0) return Promise.resolve(result);
    const data = rows.join('\n');
    return writeAsset(`lists/${list}.list`, data).then(() => result);
  });
}

// Compute two pieces of global data that can be loaded into memory once.
// kCharacters is a mapping from character to its current data version.

const kCharacters = readAsset('characters.txt').then((data) => {
  const characters = {};
  for (let line of data.split('\n')) {
    if (line.length === 0 || line[0] === '#') continue;
    if (line.length !== 1) throw new Error(`Unexpected line: ${line}`);
    characters[line] = (characters[line] || 0) + 1;
  }
  return characters;
}).catch((error) => console.error(error));

const kRadicals = readAsset('radicals.json')
    .then((data) => JSON.parse(data).radical_to_index_map)
    .catch((error) => console.error(error));

export {
  kCharacters,
  download,
  onAssetsLoaded,
  readCharacter,
  readItem,
  readList,
  removeList,
  writeCharacter,
  writeList,
};
