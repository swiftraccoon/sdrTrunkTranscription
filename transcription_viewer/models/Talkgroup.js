// models/Talkgroup.js
const mongoose = require('mongoose');

/*
 Example CSV columns (from your snippet):
 Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category
*/
const talkgroupSchema = new mongoose.Schema({
  decimal: { type: Number, required: true, unique: true }, // e.g. 4150
  hex: String, // e.g. "1036"
  alphaTag: String, // e.g. "AlamanceCo Help"
  mode: String, // e.g. "D"
  description: String, // e.g. "County Help"
  tag: String, // e.g. "Emergency Ops"
  category: String, // e.g. "Alamance County"
  // add more if CSV has more columns
});

module.exports = mongoose.model('Talkgroup', talkgroupSchema);
