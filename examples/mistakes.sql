-- Databricks notebook source
-- Open this file in VS Code with the extension installed: every statement
-- below has one mistake, and each is marked as you look at it.

CREATE CATALOG IF NOT EXISTS demo
CREATE SCHEMA IF NOT EXISTS demo.db;

CREATE TABLE IF NOT EXISTS demo.db.events (
  event_id   STRING NOT NULL COMMENT 'UUID per event'
  event_time BIGINT NOT NULL,
  category   STRING COMENT 'Main category'
);

-- COMMAND ----------

SELECT
  event_id,
  category
  event_time
FROM demo.db.events;

SELECT category, count(*) AS n
FORM demo.db.events
GROUP BY category;

SELECT category, count(*) AS n
FROM demo.db.events
GROUP BY category
WHERE event_time > 0;

-- COMMAND ----------

SELECT CASE WHEN channel = 'Shop' 1 ELSE 0 END AS shop
FROM demo.db.events;

SELECT max(event_time AS latest
FROM demo.db.events;

SELECT * FROM demo.db.events
WHERE category LIKE '%SALE%' AND;

SELECT * FROM demo.db.events WHERE category = 'x' ORDER BY event_time LIMT 10;
