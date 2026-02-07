/**
 * Word Library for PIC9UPPER
 * Reads from words.txt (CSV format)
 * Format: groupId,word1,word2,word3,word4,word5
 * word1 = correct (civilian), word2-5 = wrong (undercover)
 */

// Import words.txt as a text module (Cloudflare Workers compatible)
import WORD_LIBRARY_TEXT from "./words.txt";

let wordGroups = null;

/**
 * Parse CSV word library text into structured array
 * @returns {Array<{id: number, correct: string, wrong: string[]}>}
 */
function parseWordLibrary(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  // Skip header row if present
  const startIdx = lines[0]?.toLowerCase().includes("groupid") ? 1 : 0;

  return lines.slice(startIdx)
    .map((line) => {
      const parts = line.split(",").map((w) => w.trim()).filter(Boolean);
      if (parts.length < 3) return null; // Need at least id, correct, and one wrong word

      const id = parseInt(parts[0], 10);
      const correct = parts[1];
      const wrong = parts.slice(2);

      if (isNaN(id) || !correct) return null;

      return { id, correct, wrong };
    })
    .filter(Boolean);
}

/**
 * Get all word groups (lazy loaded from words.txt)
 */
export function getWordGroups() {
  if (!wordGroups) {
    wordGroups = parseWordLibrary(WORD_LIBRARY_TEXT);
    console.log(`Loaded ${wordGroups.length} word groups from words.txt`);
  }
  return wordGroups;
}

/**
 * Select a random word group, preferring unused ones
 * Randomly picks one word as "correct" (civilian), rest become "wrong" (undercover)
 * @param {number[]} usedGroupIds - IDs of recently used groups (from words.txt groupId column)
 * @returns {{ groupIndex: number, correct: string, wrong: string[] }}
 */
export function selectWordGroup(usedGroupIds = []) {
  const groups = getWordGroups();

  if (groups.length === 0) {
    // Fallback if no words loaded
    return {
      groupIndex: 0,
      correct: "默认词",
      wrong: ["备用词1", "备用词2"],
    };
  }

  // Filter out recently used groups by their ID
  const available = groups.filter((g) => !usedGroupIds.includes(g.id));

  // If all used, reset and pick from all groups
  const pool = available.length > 0 ? available : groups;

  // Random selection of group
  const selected = pool[Math.floor(Math.random() * pool.length)];

  // Combine all words from the group, then randomly pick one as "correct"
  const allWords = [selected.correct, ...selected.wrong];
  const shuffled = [...allWords].sort(() => Math.random() - 0.5);
  const correctWord = shuffled[0];
  const wrongWords = shuffled.slice(1);

  console.log(`Selected word group ID ${selected.id}: correct="${correctWord}", wrong=[${wrongWords.join(", ")}] (避开已用: [${usedGroupIds.join(", ")}])`);

  return {
    groupIndex: selected.id,  // Use the groupId from CSV as the index for tracking
    correct: correctWord,
    wrong: wrongWords,
  };
}

/**
 * Get wrong words for undercover players
 * @param {string[]} wrongWords - Available wrong words from the group
 * @param {number} count - Number of undercover players
 * @param {boolean} differentWords - Whether each undercover sees a different word
 * @returns {string[]} Array of words to assign to each undercover
 */
export function getUndercoverWords(wrongWords, count, differentWords) {
  if (count === 0) return [];
  if (!wrongWords || wrongWords.length === 0) return Array(count).fill("???");

  if (!differentWords) {
    // All undercover see the same wrong word (randomly chosen)
    const word = wrongWords[Math.floor(Math.random() * wrongWords.length)];
    return Array(count).fill(word);
  }

  // Each undercover sees a potentially different wrong word
  // Shuffle and cycle through if needed
  const shuffled = [...wrongWords].sort(() => Math.random() - 0.5);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(shuffled[i % shuffled.length]);
  }
  return result;
}
