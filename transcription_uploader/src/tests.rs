#[cfg(test)]
mod tests {
    use crate::parse_filename;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn test_parse_valid_filenames_with_from(
            // Use a more realistic pattern for timestamps (YYYYMMDD_HHMMSS format)
            year in 2020..2130u32,
            month in 1..12u32,
            day in 1..29u32,
            hour in 0..24u32,
            minute in 0..60u32,
            second in 0..60u32,
            prefix in r"[A-Za-z]?",
            talkgroup_id in r"[0-9]{4,5}",
            suffix in r"(\[[0-9]{4,5}\])??",
            radio_id in r"[0-9]{7}"
        ) {
            // Format timestamp like actual examples
            let timestamp = format!("{:04}{:02}{:02}_{:02}{:02}{:02}", year, month, day, hour, minute, second);
            
            // Construct a filename that closely mimics real examples
            let filename = format!("{}North_Carolina_VIPER_Test__TO_{}{}{}_FROM_{}.mp3", 
                timestamp, prefix, talkgroup_id, suffix, radio_id);
            
            // Parse the filename
            let result = parse_filename(&filename);
            
            // Check the result
            prop_assert!(result.is_some(), "Failed to parse: {}", filename);
            if let Some((parsed_timestamp, parsed_talkgroup, parsed_radio)) = result {
                prop_assert_eq!(parsed_timestamp, timestamp);
                prop_assert_eq!(parsed_talkgroup, talkgroup_id);
                prop_assert_eq!(parsed_radio, radio_id);
            }
        }

        #[test]
        fn test_parse_valid_filenames_without_from(
            // Use a more realistic pattern for timestamps (YYYYMMDD_HHMMSS format)
            year in 2020..2030u32,
            month in 1..13u32,
            day in 1..29u32,
            hour in 0..24u32,
            minute in 0..60u32,
            second in 0..60u32,
            prefix in r"[A-Za-z]?",
            talkgroup_id in r"[0-9]{4,5}"
        ) {
            // Format timestamp like actual examples
            let timestamp = format!("{:04}{:02}{:02}_{:02}{:02}{:02}", year, month, day, hour, minute, second);
            
            // Construct a filename that closely mimics real examples
            let filename = format!("{}N2GE_MtMitchell_14519NBFM__TO_{}{}.mp3", 
                timestamp, prefix, talkgroup_id);
            
            // Parse the filename
            let result = parse_filename(&filename);
            
            // Check the result
            prop_assert!(result.is_some(), "Failed to parse: {}", filename);
            if let Some((parsed_timestamp, parsed_talkgroup, parsed_radio)) = result {
                prop_assert_eq!(parsed_timestamp, timestamp);
                prop_assert_eq!(parsed_talkgroup, talkgroup_id);
                prop_assert_eq!(parsed_radio, "123456"); // Default value
            }
        }
    }

    // We can still keep a few specific test cases for clarity and documentation
    #[test]
    fn test_specific_filename_examples() {
        // Real-world example with _FROM_
        let filename = "20241223_204051North_Carolina_VIPER_Cleveland_T-BennsKControl__TO_P52189_[52193]_FROM_2151975.mp3";
        let (timestamp, talkgroup_id, radio_id) = parse_filename(filename).unwrap();
        assert_eq!(timestamp, "20241223_204051");
        assert_eq!(talkgroup_id, "52189");
        assert_eq!(radio_id, "2151975");

        // Real-world example without _FROM_
        let filename = "20241223_210126N2GE_MtMitchell_14519NBFM__TO_9999.mp3";
        let (timestamp, talkgroup_id, radio_id) = parse_filename(filename).unwrap();
        assert_eq!(timestamp, "20241223_210126");
        assert_eq!(talkgroup_id, "9999");
        assert_eq!(radio_id, "123456"); // Default value
    }

    #[test]
    fn test_parse_filename_edge_cases() {
        // Invalid format (missing __TO_)
        let filename = "20241223_210126N2GE_MtMitchell_14519NBFM_INVALID_9999.mp3";
        assert!(parse_filename(filename).is_none());

        // Invalid timestamp format
        let filename = "INVALID_TIMESTAMPNorth_Carolina_VIPER__TO_52198_FROM_2151878.mp3";
        assert!(parse_filename(filename).is_none());

        // Empty string
        assert!(parse_filename("").is_none());
    }
} 