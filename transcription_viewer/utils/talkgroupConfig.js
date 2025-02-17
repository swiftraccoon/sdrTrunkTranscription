/**
 * Talkgroup Configuration Module
 * -----------------------------
 * This module is responsible for parsing talkgroup data from a CSV file, upserting the records into MongoDB,
 * and maintaining an in-memory cache for quick lookups. It also provides utility functions to retrieve group names, 
 * talkgroup names, and group IDs based on talkgroup identifiers.
 */

// Load environment variables and required modules
require('dotenv').config(); // if using .env
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const mongoose = require('mongoose');
const Talkgroup = require('../models/Talkgroup');
const logger = require('./logger');

class TalkgroupConfig {
  constructor() {
    this.cache = {};
    this.groups = {};

    // Read comma-separated group keys from .env
    const groupKeys = (process.env.GROUP_KEYS || '').split(',');

    // For each group key, grab its value from .env and parse it
    groupKeys.forEach((key) => {
      const envVal = process.env[key.trim()];
      if (envVal) {
        this.groups[key.trim()] = this.parseGroupRanges(envVal);
      }
    });
  }

  /**
   * Main init method
   * 1) Optionally connect to Mongo if not done externally
   * 2) Parse CSV
   * 3) Upsert each talkgroup into DB
   * 4) Load all into this.cache
   */
  async init() {
    try {
      // If your server.js is already doing mongoose.connect(...),
      // you can skip this next line or check if (mongoose.connection.readyState === 0)
      const dbUrl = process.env.DATABASE_URL || 'mongodb://127.0.0.1/transcriptionViewer';
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(dbUrl);
        logger.info('Database connection established for talkgroup config');
      }

      // Parse CSV
      const csvData = this.parseCSV();
      if (!csvData || csvData.length === 0) {
        logger.warn('No valid records found in talkgroup CSV');
      } else {
        // Upsert into DB
        await this.upsertAll(csvData);
        logger.info('Talkgroup CSV data processed', { recordCount: csvData.length });
      }

      // Load into in-memory cache
      await this.loadCacheFromDB();
      logger.info('Talkgroup cache loaded', { count: Object.keys(this.cache).length });

      this.initialized = true;
    } catch (err) {
      logger.error('Talkgroup initialization failed', {
        error: err.message,
        stack: err.stack,
      });
    }
  }

  /**
   * Parse the CSV synchronously using csv-parse/sync
   */
  parseCSV() {
    const csvFilePath = path.join(__dirname, 'trs_tg_7118.csv');
    // Adjust filename & path to your CSV
    if (!fs.existsSync(csvFilePath)) {
      logger.error('Talkgroup CSV file not found', { path: csvFilePath });
      return [];
    }

    try {
      const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
      return parse(fileContent, {
        columns: true, // treat first row as headers
        skip_empty_lines: true,
      });
    } catch (err) {
      logger.error('Failed to parse talkgroup CSV', {
        error: err.message,
        stack: err.stack,
      });
      return [];
    }
  }

  /**
   * Upsert each row from CSV into DB. If a record with the same decimal already exists,
   * we overwrite it. If not, we create a new one.
   */
  async upsertAll(csvRecords) {
    // We'll do a "bulkWrite" approach for efficiency
    const ops = csvRecords.map((row) => ({
      updateOne: {
        filter: { decimal: Number(row.Decimal) },
        update: {
          $set: {
            decimal: Number(row.Decimal),
            hex: row.Hex || null,
            alphaTag: row['Alpha Tag'] || null,
            mode: row.Mode || null,
            description: row.Description || null,
            tag: row.Tag || null,
            category: row.Category || null,
          },
        },
        upsert: true,
      },
    }));

    if (ops.length === 0) return; // nothing to do
    try {
      const result = await Talkgroup.bulkWrite(ops);
      logger.info('Talkgroup bulk update completed', {
        matched: result.matchedCount,
        upserted: result.upsertedCount,
        modified: result.modifiedCount,
      });
    } catch (err) {
      logger.error('Talkgroup bulk update failed', {
        error: err.message,
        stack: err.stack,
      });
    }
  }

  /**
   * Load all talkgroups from DB into this.cache (in-memory).
   */
  async loadCacheFromDB() {
    const allTGs = await Talkgroup.find({});
    this.cache = {}; // reset
    allTGs.forEach((tg) => {
      this.cache[tg.decimal.toString()] = {
        decimal: tg.decimal,
        hex: tg.hex,
        alphaTag: tg.alphaTag,
        mode: tg.mode,
        description: tg.description,
        tag: tg.tag,
        category: tg.category,
      };
    });
  }

  /**
   * Example method: get talkgroup name from in-memory cache
   * (You can define your own logic or combine fields, etc.)
   */
  getTalkgroupName(decimalId) {
    const data = this.cache[decimalId.toString()];
    if (!data) {
      return `TGID ${decimalId}`;
    }
    // For instance, if you want to show "AlphaTag (Description)":
    if (data.alphaTag && data.description) {
      return `${data.alphaTag} (${data.description})`;
    } if (data.description) {
      return data.description;
    } if (data.alphaTag) {
      return data.alphaTag;
    }
    return `TGID ${decimalId}`; // fallback
  }

  parseGroupRanges(ranges) {
    if (!ranges) return [];

    return ranges.split(',').flatMap((segment) => {
      const trimmed = segment.trim();
      if (!trimmed) return [];

      const parts = trimmed.split('-');
      if (parts.length === 1) {
        const num = parseInt(parts[0], 10);
        return Number.isNaN(num) ? [] : [num];
      }

      const start = parseInt(parts[0], 10);
      const end = parseInt(parts[1], 10);

      if (Number.isNaN(start) || Number.isNaN(end)) {
        return [];
      }

      return Array.from(
        { length: end - start + 1 },
        (_, i) => start + i,
      );
    });
  }

  getGroupName(talkgroupId) {
    const tgNum = Number(talkgroupId);
    if (Number.isNaN(tgNum)) return null;

    return Object.entries(this.groups).find(([, segments]) => 
      segments.some((num) => num === tgNum))?.[0] || null;
  }

  getAllGroups() {
    return ['All'].concat(Object.keys(this.groups));
  }

  getGroupMappings() {
    const groupMappings = {};
    const groupKeys = (process.env.GROUP_KEYS || '').split(',');
    groupKeys.forEach(key => {
      if (process.env[key.trim()]) {
        groupMappings[key.trim()] = process.env[key.trim()];
      }
    });
    return groupMappings;
  }

  getGroupIds(groupName) {
    // e.g. this.groups['EMS'] = [
    //   { type: 'single', value: 1 },
    //   { type: 'range', start: 300, end: 500 },
    //   { type: 'range', start: 9999, end: 999999 }
    // ]
    const segments = this.groups[groupName];
    if (!segments) {
      return [];
    }

    return segments.map(String);
  }
}

// Export a single instance
const talkgroupConfig = new TalkgroupConfig();
module.exports = talkgroupConfig;
