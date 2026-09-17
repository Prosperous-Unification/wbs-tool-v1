import { importServiceSourceContract } from '@wbs/core/testing/import-service-source-contract';

import { openMemorySource } from './source';

importServiceSourceContract(() => Promise.resolve(openMemorySource()));
