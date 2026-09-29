import 'dotenv/config';
import { buildApp } from '../../src/app.js';

export async function getTestApp() {
  return buildApp();
}
