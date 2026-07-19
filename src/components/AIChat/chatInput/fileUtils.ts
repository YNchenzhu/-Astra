/** Read a File into a bare base64 string (data-URL prefix stripped). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
}
