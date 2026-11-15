export const GARDEN_COLUMNS = 18;
export const GARDEN_ROWS = 10;
export const GARDEN_PLANT_TYPES = ['clover', 'wildflower', 'sunflower', 'grass', 'sapling'] as const;
export type GardenPlantType = typeof GARDEN_PLANT_TYPES[number];
export type GardenStage = 'seed' | 'sprout' | 'young' | 'mature';
