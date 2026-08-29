-- 1. Single-row Goals Document
CREATE TABLE user_goals (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    plan_data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Body Metrics
CREATE TABLE body_metrics (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
    weight_lbs NUMERIC(5,2),
    waist_inches NUMERIC(4,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Daily Notes
CREATE TABLE daily_notes (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
    energy_level INT CHECK (energy_level BETWEEN 1 AND 10),
    challenges TEXT,
    victories TEXT,
    general_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Meals Table
CREATE TABLE meals (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    log_time TIME DEFAULT CURRENT_TIME,
    meal_type TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'snack', 'dinner')),
    food_name TEXT NOT NULL,
    quantity NUMERIC NOT NULL,
    units TEXT NOT NULL,
    calories INT NOT NULL,
    protein_g NUMERIC DEFAULT 0,
    carbs_g NUMERIC DEFAULT 0,
    fat_g NUMERIC DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Exercises Table
CREATE TABLE exercises (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    activity_description TEXT NOT NULL,
    sets INT,
    reps INT,
    weight_lbs NUMERIC,
    distance_miles NUMERIC,
    step_count INT,
    calories_burned INT DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Shared trigger: keeps updated_at current on every UPDATE (DEFAULT only fires on INSERT)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_goals_set_updated_at
BEFORE UPDATE ON user_goals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER body_metrics_set_updated_at
BEFORE UPDATE ON body_metrics
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER daily_notes_set_updated_at
BEFORE UPDATE ON daily_notes
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER meals_set_updated_at
BEFORE UPDATE ON meals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER exercises_set_updated_at
BEFORE UPDATE ON exercises
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- 6. Daily Summary Rollup View
CREATE OR REPLACE VIEW daily_summaries AS
SELECT 
    d.log_date,
    COALESCE(m.total_calories, 0) AS calories_consumed,
    COALESCE(m.total_protein, 0) AS protein_g,
    COALESCE(m.total_carbs, 0) AS carbs_g,
    COALESCE(m.total_fat, 0) AS fat_g,
    COALESCE(e.calories_burned, 0) AS calories_burned,
    (COALESCE(m.total_calories, 0) - COALESCE(e.calories_burned, 0)) AS net_calories
FROM 
    (SELECT DISTINCT log_date FROM meals UNION SELECT DISTINCT log_date FROM exercises) d
LEFT JOIN 
    (SELECT log_date, SUM(calories) as total_calories, SUM(protein_g) as total_protein, 
            SUM(carbs_g) as total_carbs, SUM(fat_g) as total_fat 
     FROM meals GROUP BY log_date) m ON d.log_date = m.log_date
LEFT JOIN 
    (SELECT log_date, SUM(calories_burned) as calories_burned 
     FROM exercises GROUP BY log_date) e ON d.log_date = e.log_date;