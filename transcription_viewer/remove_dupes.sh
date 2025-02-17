#!/usr/bin/env bash

# A script to remove duplicate transcriptions from the `transcriptions` collection in the `transcriptionViewer` DB
# Usage: ./remove_dupes.sh
#       Adjust MONGODB_URI or DB/COLLECTION names if needed.

MONGODB_URI="mongodb://127.0.0.1/transcriptionViewer"
COLLECTION="transcriptions"

mongosh "$MONGODB_URI" <<EOF

print("Connected to MongoDB URI: $MONGODB_URI");
print("Finding duplicates in the $COLLECTION collection...");

/*
  This aggregation groups documents by (talkgroupId, radioId, timestamp).
  If \`count > 1\`, that means duplicates exist.
  We keep the first doc in each group, then remove the others.
*/
db.$COLLECTION.aggregate([
  {
    \$group: {
      _id: {
        talkgroupId: "\$talkgroupId",
        radioId: "\$radioId",
        timestamp: "\$timestamp"
      },
      ids: { \$push: "\$_id" },
      count: { \$sum: 1 }
    }
  },
  {
    \$match: { count: { \$gt: 1 } }
  }
]).forEach(group => {
  const allIds = group.ids;
  // Keep the first ID, remove the rest
  const [ keep, ...duplicates ] = allIds;

  // Output info about what we're deleting
  print("Found duplicates for (talkgroupId, radioId, timestamp) =",
        JSON.stringify(group._id),
        "Deleting", duplicates.length, "docs, keeping _id=" + keep);

  if (duplicates.length > 0) {
    // Actually remove the duplicates
    db.$COLLECTION.deleteMany({ _id: { \$in: duplicates } });
  }
});

print("Done removing duplicates. Check logs above for details.");
EOF
