const fs = require('fs');
const path = require('path');

/**
 *
 * @param {string} cacheDir
 * @param {function(fileName:string, content:Buffer):void} [onSet=null]
 * @param {function(fileName:string, content:Buffer):void} [onMemoryRemove=null]
 * @param {number} [memoryTTL=10_000] メモリからキャッシュが削除されるまでの最後の書き込み/読み取りからの時間。デフォルト：10秒
 * @param {function(fileName:string, content:Buffer):void} [onFileRemove=null]
 * @param {number} [fileTTL=600_000] キャッシュファイルが削除されるまでの最後の書き込み/読み取りからの時間。デフォルト：10分
 * @return {Object.<Buffer|Promise<Buffer>>} 書き込みの時は Buffer を代入、読み取りの時は Promise<Buffer> が取得されます
 */
module.exports = (cacheDir, onSet=null, onMemoryRemove=null, memoryTTL=10_000, onFileRemove=null, fileTTL=600_000)=>
{
	const handler = {};
	const target = {};

	/** @type {Object.<Promise<Buffer>>} */
	const promiseCaches = {};

	/** @type {Object.<Buffer>} */
	const memoryCaches = {};

	/** @type {Object.<NodeJS.Timeout|number>} */
	const memoryTimeLimits = {};

	/** @type {Object.<NodeJS.Timeout|number>} */
	const fileTimeLimits = {};

	/** @type {Object.<boolean>} */
	const isFileAccessing = {};

	/** @type {Object.<Buffer>} */
	const hasQueue = {};

	handler.set = (target, fileName, content)=>
	{
		if(onSet) onSet(fileName, content);
		if(typeof isFileAccessing[fileName] !== "undefined")
		{
			isFileAccessing[fileName] = true;
			if(typeof memoryCaches[fileName] !== 'undefined')
			{
				writeFile(fileTimeLimits, memoryCaches, onFileRemove, fileTTL, fileName, cacheDir, content, memoryTimeLimits, onMemoryRemove, memoryTTL, isFileAccessing, hasQueue, proxy)
			}
			else
			{
				readFile(isFileAccessing, fileName, cacheDir, hasQueue, proxy, (error, data)=>
				{
					if(error) memoryCaches[fileName] = null;
					else memoryCaches[fileName] = data;

					writeFile(fileTimeLimits, memoryCaches, onFileRemove, fileTTL, fileName, cacheDir, content, memoryTimeLimits, onMemoryRemove, memoryTTL, isFileAccessing, hasQueue, proxy)
				});
			}
		}
		else
		{
			hasQueue[fileName] = content;
		}
	}

	handler.get = (target, fileName)=>
	{
		if(typeof promiseCaches[fileName] !== "undefined") return promiseCaches[fileName];

		if(typeof memoryCaches[fileName] !== "undefined")
		{
			promiseCaches[fileName] = new Promise(resolve => resolve(memoryCaches[fileName]));
			scheduleRemoveMemoryCache(memoryTimeLimits, fileName, onMemoryRemove, memoryCaches, memoryTTL);
			return promiseCaches[fileName];
		}

		promiseCaches[fileName] = new Promise(resolve =>
		{
			readFile(isFileAccessing, fileName, cacheDir, hasQueue, proxy, (error, data)=>
			{
				if(error) return resolve(null);

				memoryCaches[fileName] = data;
				scheduleRemoveMemoryCache(memoryTimeLimits, fileName, onMemoryRemove, memoryCaches, memoryTTL);
				scheduleRemoveFileCache(fileTimeLimits, cacheDir, fileName, onFileRemove, fileTTL, isFileAccessing, hasQueue, proxy);
			});
		});
		return promiseCaches[fileName];
	}

	const proxy = new Proxy(target, handler);

	return proxy;
}

const readFile = (isFileAccessing, fileName, cacheDir, hasQueue, proxy, callback)=>
{
	isFileAccessing[fileName] = true;
	fs.readFile(path.join(cacheDir, fileName), null, (error, data)=>
	{
		delete isFileAccessing[fileName];
		callback(error, data);
		onFileAccessComplete(isFileAccessing, fileName, hasQueue, proxy);
	});
}

const writeFile = (fileTimeLimits, memoryCaches, onFileRemove, fileTTL, fileName, cacheDir, newContent, memoryTimeLimits, onMemoryRemove, memoryTTL, isFileAccessing, hasQueue, proxy)=>
{
	if(memoryCaches[fileName] !== newContent)
	{
		memoryCaches[fileName] = newContent;
		isFileAccessing[fileName] = true;
		fs.writeFile(path.join(cacheDir, fileName), newContent, null, (error)=>
		{
			if(error) throw error;
			onFileAccessComplete(isFileAccessing, fileName, hasQueue, proxy);
			scheduleRemoveFileCache(fileTimeLimits, cacheDir, fileName, onFileRemove, fileTTL, isFileAccessing, hasQueue, proxy);
		});
		scheduleRemoveMemoryCache(memoryTimeLimits, fileName, onMemoryRemove, memoryCaches, memoryTTL);
	}
}

const onFileAccessComplete = (isFileAccessing, fileName, hasQueue, proxy)=>
{
	delete isFileAccessing[fileName];
	if(typeof hasQueue[fileName] !== "undefined")
	{
		proxy[fileName] = hasQueue[fileName];
		hasQueue[fileName] = null;
		delete hasQueue[fileName];
	}
}

const scheduleRemoveMemoryCache = (memoryTimeLimits, fileName, onMemoryRemove, memoryCaches, memoryTTL)=>
{
	if(memoryTimeLimits[fileName]) clearTimeout(memoryTimeLimits[fileName]);
	memoryTimeLimits[fileName] = setTimeout(()=>
	{
		if(onMemoryRemove) onMemoryRemove(fileName, memoryCaches[fileName]);
		memoryCaches[fileName] = null;
		memoryTimeLimits[fileName] = null;
		delete memoryCaches[fileName];
	}, memoryTTL);
}

const scheduleRemoveFileCache = (fileTimeLimits, cacheDir, fileName, onFileRemove, fileTTL, isFileAccessing, hasQueue, proxy)=>
{
	if(fileTimeLimits[fileName]) clearTimeout(fileTimeLimits[fileName]);
	fileTimeLimits[fileName] = setTimeout(()=>
	{
		if(typeof isFileAccessing[fileName] === "undefined")
		{
			if(onFileRemove)
			{
				readFile(isFileAccessing, fileName, cacheDir, hasQueue, proxy, (error, data)=>
				{
					if(!error)
					{
						onFileRemove(fileName, data);
						removeFile(cacheDir, fileName, isFileAccessing, hasQueue, proxy);
					}
				})
			}
			else removeFile(cacheDir, fileName, isFileAccessing, hasQueue, proxy);
		}
		
		fileTimeLimits[fileName] = null;
		delete fileTimeLimits[fileName];
	}, fileTTL);
}

const removeFile = (cacheDir, fileName, isFileAccessing, hasQueue, proxy)=>
{
	isFileAccessing[fileName] = true;
	fs.rm(path.join(cacheDir, fileName), null, error=>
	{
		if(error) throw error;
		onFileAccessComplete(isFileAccessing, fileName, hasQueue, proxy);
	});
}