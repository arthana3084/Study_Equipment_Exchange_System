// db/connection.js
const mysql = require('mysql2');

// Adjust user/password/database as per your MySQL setup
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',       // your MySQL username
  password: 'Arthana@2004',       // your MySQL password
  database: 'study_equipment',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool.promise();
