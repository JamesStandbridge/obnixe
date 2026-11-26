import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_entry_planned_sets.sql';
import m0002 from './0002_gps_recording.sql';
import m0003 from './0003_trail_sport.sql';
import m0004 from './0004_recording_derivation.sql';
import m0005 from './0005_mask_in_app.sql';
import m0006 from './0006_weather_fetch.sql';
import m0007 from './0007_segments.sql';
import m0008 from './0008_routes.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008
    }
  }
  