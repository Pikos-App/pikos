#!/usr/bin/env node

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME_DIR = process.env.HOME || process.env.USERPROFILE;
const SEED_DIR = join(HOME_DIR, "Documents", "pikos", "seed");

async function ensureSeedDir() {
  try {
    await fs.mkdir(SEED_DIR, { recursive: true });
  } catch (error) {
    console.error("Failed to create seed directory:", error);
    throw error;
  }
}

export async function getLastUntitledNumber() {
  try {
    await ensureSeedDir();
    const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });

    const files = entries.filter((entry) => entry.isFile());
    const untitledFiles = files.filter((file) => file.name.startsWith("untitled"));

    if (untitledFiles.length === 0) return 0;

    const numbers = untitledFiles.map((file) => {
      const match = file.name.match(/untitled\s*(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });

    return Math.max(...numbers, 0);
  } catch (error) {
    console.error("Error in getLastUntitledNumber:", error);
    throw error;
  }
}

export async function seedFiles(count = 100) {
  try {
    const lastNumber = await getLastUntitledNumber();

    for (let i = 1; i <= count; i++) {
      const fileName = `untitled ${lastNumber + i}.md`;
      const filePath = join(SEED_DIR, fileName);

      await fs.writeFile(filePath, `# ${fileName}\n\nNew document created at ${new Date().toISOString()}`, "utf8");

      console.log(`Created: ${filePath}`);
    }

    console.log(`Successfully created ${count} files.`);
  } catch (error) {
    console.error("Error in seedFiles:", error);
    throw error;
  }
}

// Run the script if this file is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = parseInt(process.argv[2], 10) || 1000;
  seedFiles(count).catch(console.error);
}
