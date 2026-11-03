// Runs before every integration test file. Environment values are set by each test once its
// database is known; this only loads what libraries need before any import.
// @peculiar/x509 needs reflect-metadata before it is imported.
import 'reflect-metadata';
