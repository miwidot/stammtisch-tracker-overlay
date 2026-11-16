/** Public-source baselines for exits omitted or underspecified by the game definitions.
 * No additional mechanical restriction is documented; keys remain in extractCues.json5.
 * These references are best-effort across PvP, PvE and Seasonal, not captured rules.
 * See docs/EXTRACT_REQUIREMENTS_AUDIT.md for source revisions and the 13 exclusions.
 */
export type CuratedExtractBaselines = Record<
  string,
  Record<string, { name: string; reference: string }>
>;

export const CURATED_EXTRACT_BASELINES: CuratedExtractBaselines = {
  '55f2d3fd4bdc2d5f408b4567': {
    // Factory: Med Tent Gate. Was: missing or unknown mechanical baseline.
    '4b93f765fc6e0b6379679b3c827074d4e57ff680': {
      name: 'Gate m',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Cellars. Was: missing or unknown mechanical baseline.
    f261d229a5b13a3292a4a49dced2a4949dfc342b: {
      name: 'Cellars',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Gate 3. Was: missing or unknown mechanical baseline.
    f16ce849a9d153a8813b6bf6a049d530f1cc44c2: {
      name: 'Gate 3',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Courtyard Gate. Was: missing or unknown mechanical baseline.
    b1e817c36812ebf2a8b1ac141ca88449a0b0469c: {
      name: 'Gate_o',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Camera Bunker Door. Was: missing or unknown mechanical baseline.
    '29b887a73725274d657c8a5366614b9b900387e2': {
      name: 'Camera Bunker Door',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Office Window. Was: missing or unknown mechanical baseline.
    '1733510cd360e7a13af356612afad7214aae64e4': {
      name: 'Office Window',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
    // Factory: Gate 0. Was: missing or unknown mechanical baseline.
    '99c2f21880da0baf75d431a5f45b462fde2f79b1': {
      name: 'Gate 0',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Factory#Extractions',
    },
  },
  '56f40101d2720b2a4d8b45d6': {
    // Customs: Old Gas Station. Was: missing or unknown mechanical baseline.
    d2cefbb74bd24ffc53a1a3a148069483c5fae6cb: {
      name: 'ex_customs_scav_gasstation',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Administration Gate. Was: missing or unknown mechanical baseline.
    '92e7412193276c1044299b51d930440cdab835e4': {
      name: 'ex_customs_scav_admin',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Old Road Gate. Was: missing or unknown mechanical baseline.
    '1e7baccc265b49195aead2e783779cbca83d73f3': {
      name: 'Old Road Gate',
      reference: 'https://tarkov.help/en/map/customs/extractions/old-road-gate-extraction-point',
    },
    // Customs: Crossroads. Was: missing or unknown mechanical baseline.
    fc4876c616edf234b1b0b75fb02fce784e54a6c2: {
      name: 'ex_customs_scav_crossroads',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Railroad to Reserve. Was: missing or unknown mechanical baseline.
    '74840d2d5d9c332e466148e94be1ab4ef0fb3ac4': {
      name: 'ex_customs_scav_rail_milbase',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Railroad to Port. Was: missing or unknown mechanical baseline.
    bf421e259c2e851b159401432318bcca326b16d5: {
      name: 'ex_customs_scav_rail_port',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Gate Near Medblock. Was: missing or unknown mechanical baseline.
    '0eedf7dfd9db21b60e216ebccbf52271a06cddf6': {
      name: 'ex_customs_scav_medgate',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Railroad to Tarkov. Was: missing or unknown mechanical baseline.
    '46979e6dd937e83470b013382282919388a07f8c': {
      name: 'ex_customs_scav_rail_tarkov',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Reserve Checkpoint. Was: missing or unknown mechanical baseline.
    '973dfce3d353b26fe9b3e9373bd4536d26fffc05': {
      name: 'ex_customs_scav_milbase_cp',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: ZB-1011. Was: missing or unknown mechanical baseline.
    f57705238de721e427d8ea262f7226f804e88726: {
      name: 'ex_customs_scav_zb1011',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
    // Customs: Trailer Park. Was: missing or unknown mechanical baseline.
    f3f0171d1c8396a152e319f372c4e9d9df120e73: {
      name: 'ex_customs_scav_trailerpark',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Customs#Extractions',
    },
  },
  '5704e3c2d2720bac5b8b4567': {
    // Woods: Old Railway Depot. Was: missing or unknown mechanical baseline.
    beefde059ae2d331c8d568066518e0293ff9da59: {
      name: 'Old Station',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Scav House. Was: missing or unknown mechanical baseline.
    '3e64a0665e093dac84499dc50e2768684e8bd508': {
      name: 'Scav House',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Eastern Rocks. Was: missing or unknown mechanical baseline.
    '6363090af9e0ab1a3d0f7154ea89e1c1c362e30d': {
      name: 'West Border',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Mountain Stash. Was: missing or unknown mechanical baseline.
    '7692ab53faec4d1c375212a2bca01796de7c4cdb': {
      name: 'Mountain Stash',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Scav Bunker. Was: missing or unknown mechanical baseline.
    dc49f6444b7e835b4cfb2589e1df68a21a9bf3c9: {
      name: 'East Gate',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Dead Man's Place. Was: missing or unknown mechanical baseline.
    '495bcac9e8a677cef40194ea3c57d65f2c4276d9': {
      name: "Dead Man's Place",
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
    // Woods: Boat. Was: missing or unknown mechanical baseline.
    b6371d7a90e044c79df5dbc651983ddabbc9b2bf: {
      name: 'The Boat',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Woods#Extractions',
    },
  },
  '5704e4dad2720bb55b8b4567': {
    // Lighthouse: Southern Road Landslide. Was: missing or unknown mechanical baseline.
    aa9a937fb2c3c2d51fe21ab457ab0613ff5e2539: {
      name: 'Scav_Coastal_South',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions',
    },
    // Lighthouse: Path to Shoreline. Was: missing or unknown mechanical baseline.
    '29fc02598426cdcb78bf9e07e188680ce0e8730d': {
      name: 'Shorl_free_scav',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions',
    },
    // Lighthouse: Hideout Under the Landing Stage. Was: missing or unknown mechanical baseline.
    '3ab7031964d90e541d16b1307d2017f424518b49': {
      name: 'Scav_Underboat_Hideout',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions',
    },
    // Lighthouse: Scav Hideout at the Grotto. Was: missing or unknown mechanical baseline.
    e2d5caeaeb8747a3182be5bfc98cad24892a2d00: {
      name: 'Scav_Hideout_at_the_grotto',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions',
    },
    // Lighthouse: Industrial Zone Gates. Was: missing or unknown mechanical baseline.
    '4d2faa68a953a89cc697348f947ef24d9a626380': {
      name: 'Scav_Industrial_zone',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions',
    },
  },
  '5704e554d2720bac5b8b456e': {
    // Shoreline: Admin Basement. Was: missing or unknown mechanical baseline.
    '3475b9df1bf661d3c746ff1a1a8493bae828b939': {
      name: 'Adm Basement',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions',
    },
    // Shoreline: Lighthouse. Was: missing or unknown mechanical baseline.
    '566161efb75d27f6347b9d0f610cd423dcdf319f': {
      name: 'Lighthouse',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions',
    },
    // Shoreline: Ruined Road. Was: missing or unknown mechanical baseline.
    aa2c447aa7f49a1795efd56aad7ef0670888425f: {
      name: 'Wrecked Road',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions',
    },
    // Shoreline: Road to Customs. Was: missing or unknown mechanical baseline.
    '95406652decb52abdd763626e88024931990da7d': {
      name: 'Scav Road to Customs',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions',
    },
    // Shoreline: East Wing Gym Entrance. Was: missing or unknown mechanical baseline.
    a048afd75fd279f62ee3da4fb0f38c42d8b7a934: {
      name: 'RWing Gym Entrance',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions',
    },
  },
  '5704e5fad2720bc05b8b4567': {
    // Reserve: Heating Pipe. Was: missing or unknown mechanical baseline.
    '493cc117068458f12944b1b83710116395831e21': {
      name: 'Exit2',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Reserve#Extractions',
    },
    // Reserve: Hole in the Wall by the Mountains. Was: missing or unknown mechanical baseline.
    '4603ee6acd4e4873aadc865fc476e0c0e3b4c724': {
      name: 'Exit1',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Reserve#Extractions',
    },
    // Reserve: Checkpoint Fence. Was: missing or unknown mechanical baseline.
    '037fb35378864fe476e2b1bb8b6a613ee8ac7101': {
      name: 'Exit4',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Reserve#Extractions',
    },
    // Reserve: Depot Hermetic Door. Was: missing or unknown mechanical baseline.
    '3a5be2ffaa91dc56af778ea406023197d32b33c7': {
      name: 'Exit3',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Reserve#Extractions',
    },
  },
  '5714dbc024597771384a510d': {
    // Interchange: Railway Exfil. Was: missing or unknown mechanical baseline.
    '4cf9e8c499daa3f18291b2fce601e6dd0be66882': {
      name: 'ex_interchange_scav_railway',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Interchange#Extractions',
    },
    // Interchange: Emercom Checkpoint. Was: missing or unknown mechanical baseline.
    f60ee7a996094e3a9c0cb1155a6e20558a4386db: {
      name: 'ex_interchange_scav_emercom',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Interchange#Extractions',
    },
  },
  '5714dc692459777137212e12': {
    // Streets of Tarkov: Cardinal Apartment Complex Parking. Was: missing or unknown mechanical baseline.
    '177bd2a8abcb68ca8d1964d6c5efdfeeb3f6abb8': {
      name: 'scav_e7',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
    // Streets of Tarkov: Entrance to Catacombs. Was: missing or unknown mechanical baseline.
    b89e9f9cc4529c5ba4b2487c6a5331c694d0d22a: {
      name: 'scav_e2',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
    // Streets of Tarkov: Klimov Shopping Mall Exfil. Was: missing or unknown mechanical baseline.
    '9ab4ef82011a4ebdb53413d61c806c12d731ebd4': {
      name: 'scav_e8',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
    // Streets of Tarkov: Near Kamchatskaya Arch. Was: missing or unknown mechanical baseline.
    '91ef53b9da2e2c8d3dab3a51536d24d149af44c5': {
      name: 'scav_e5',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
    // Streets of Tarkov: Ventilation Shaft. Was: missing or unknown mechanical baseline.
    d40366cc1831e903e3c9ddb3a28063a7baa45a6a: {
      name: 'scav_e3',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
    // Streets of Tarkov: Sewer Manhole. Was: missing or unknown mechanical baseline.
    '1adaba531eb66eae1ef23896862a3681ed23a67f': {
      name: 'scav_e4',
      reference: 'https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions',
    },
  },
};
