// frontend/frontend/js/supabaseClient.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://urocmdevnccdbhckvhlu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyb2NtZGV2bmNjZGJoY2t2aGx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzODgyMDgsImV4cCI6MjA3Mzk2NDIwOH0.6w9JFId7YPWoxloZjcvMq2E7-n4oTcXNhy9hH9npSDk';

window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
