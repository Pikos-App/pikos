-- Creates the table SQLite keeps planner statistics in, while the workspace opens and nothing else
-- runs. Left to the first background statistics pass, creating it changed the schema under writes
-- running on other connections, and those failed with "no such table". Analyzing the folders
-- table alone creates it and stays cheap on a large workspace.
ANALYZE folders;
