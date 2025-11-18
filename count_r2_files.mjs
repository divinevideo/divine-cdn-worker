// ABOUTME: Count total files in R2 bucket with proper pagination
// ABOUTME: Breaks down counts by uploads/ vs other files

async function countR2Files() {
  let cursor;
  let totalCount = 0;
  let uploadsCount = 0;
  let page = 1;

  while (true) {
    const url = new URL('https://blossom.divine.video/_list_r2');
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    const data = await response.json();

    totalCount += data.count;
    uploadsCount += data.objects.filter(o => o.key.startsWith('uploads/')).length;

    console.log(`Page ${page}: +${data.count} files (total: ${totalCount}, uploads: ${uploadsCount})`);

    if (!data.truncated) break;
    cursor = data.cursor;
    page++;

    if (page > 200) {
      console.log('Stopping at page 200...');
      break;
    }
  }

  console.log('');
  console.log(`Total files in R2: ${totalCount.toLocaleString()}`);
  console.log(`Files in uploads/: ${uploadsCount.toLocaleString()}`);
  console.log(`Other files: ${(totalCount - uploadsCount).toLocaleString()}`);
}

countR2Files().catch(err => console.error(err));
