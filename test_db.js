require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
async function run() {
  const { data, error } = await supabase.from('profiles').select('*').limit(1);
  console.log(JSON.stringify(data[0] || {}, null, 2));
}
run();
