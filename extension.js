// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	let disposable = vscode.commands.registerCommand('vue-class-transform.transformClass', async function () {
		const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }

        let activeLine = editor.document.lineAt(editor.selection.active.line);

        if (activeLine.text.includes(':class="{')) {
            handleBind(editor);
        } else if (activeLine.text.includes('class="') || activeLine.text.match(/:class="`.*`"/)) {
            handleString(editor, activeLine);
        } else {
			let lineNumber = editor.selection.active.line;
			do {
				lineNumber--;
				activeLine = editor.document.lineAt(lineNumber);
			} while (lineNumber > 0 && !activeLine.text.includes(':class="{') && !activeLine.text.includes('class="') && !activeLine.text.match(/:class="`.*`"/));

			if (activeLine.text.includes(':class="{')) {
				handleBind(editor);
			} else if (activeLine.text.includes('class="') || activeLine.text.match(/:class="`.*`"/)) {
				handleString(editor, activeLine);
			} else {
				vscode.window.showInformationMessage('No recognizable Vue class format found.');
			}
        }
	});

	context.subscriptions.push(disposable);
}

async function handleBind(editor) {
	// Transform from :class object to class string or template literal
	const entireClassObject = await extractEntireClassObject(editor.document, editor.selection.active);
	
	if (entireClassObject) {
		const { range, objectText } = entireClassObject;
		const classValue = parseVueObjectToClass(objectText);
		await editor.edit(editBuilder => {
			editBuilder.replace(range, classValue);
		});
	} else {
		vscode.window.showInformationMessage(':class object not properly closed or malformed');
	}
}

async function handleString(editor, activeLine) {
	// Transform from class string or template literal to :class object
	const match = activeLine.text.match(/class="([^"]*)"|:class="([^"]*)"/);
	
	if (match) {
		const classValue = match[0];
		const vueClassObject = convertClassToVueObject(classValue);
		
		await editor.edit(editBuilder => {
			editBuilder.replace(activeLine.range, activeLine.text.replace(/(class="[^"]*"|:class="[^"]*")/, vueClassObject));
		});
	}
}

async function extractEntireClassObject(document, position) {
    let startLine = position.line;
    let endLine = position.line;
    let startCharacterIndex;
    let endCharacterIndex;
    let lineText = document.lineAt(position.line).text;

    // Find the start of the :class object
    while (startLine >= 0 && !lineText.includes(':class="{')) {
        startLine--;
        lineText = document.lineAt(startLine).text;
    }

    // If :class="{ is found, locate its position for accurate range calculation
    if (lineText.includes(':class="{')) {
        startCharacterIndex = lineText.indexOf(':class="{');
    }

    // Reset to current line to search for the end
    endLine = position.line;
    lineText = document.lineAt(position.line).text;

    // Find the end of the :class object
    while (endLine < document.lineCount && !lineText.includes('}"')) {
        endLine++;
        lineText = document.lineAt(endLine).text;
    }

    // Once found, determine the end character index for accurate range calculation
    if (lineText.includes('}"')) {
        endCharacterIndex = lineText.indexOf('}"') + 2; // Include the closing characters
    }

    if (startLine >= 0 && endLine < document.lineCount) {
        // Adjust the range to precisely cover the :class attribute
        const range = new vscode.Range(
            new vscode.Position(startLine, startCharacterIndex),
            new vscode.Position(endLine, endCharacterIndex)
        );
        const objectText = document.getText(range);
       
		return { range, objectText };
    }

    return null;
}

function parseVueObjectToClass(objectText) {
    objectText = objectText.trim().replace(/^:class="\{\s*/, '').replace(/\s*\}"/, '');
    const parts = objectText.split(',').map(part => part.trim());
    const classParts = parts.reduce((acc, part) => {
        // Extracting dynamic parts (template literals) and static class names
        const dynamicMatch = part.match(/^\[\`(.+)\`\]: true$/);
        const staticMatch = part.match(/^'([^']+)'(?:\: true)$/);
        const arrayNotationMatch = part.match(/^\[\s*'([^']+)'s*\]: true$/);

        if (dynamicMatch) {
            const dynamicPart = dynamicMatch[1];
            
			acc.push(dynamicPart);
        } else if (staticMatch) {
            acc.push(staticMatch[1]); // Normal static classes
        } else if (arrayNotationMatch) {
            acc.push(arrayNotationMatch[1]); // Static classes in array notation
        }
        return acc;
    }, []);

    // Determine the format based on the presence of dynamic expressions
    if (classParts.some(part => part.includes('${'))) {
        // Dynamic expressions present, use template literal
        return `:class="\`${classParts.join(' ')}\`"`;
    } else {
        // Only static classes, use simple class string
        return `class="${classParts.join(' ')}"`;
    }
}

function convertClassToVueObject(classValue) {
    // Remove the initial part of the class attribute and trim surrounding quotes/backticks
    classValue = classValue.replace(/^(class="|:class=")|(")$/g, '');

    const parts = splitClassValue(classValue);
    const classObjectParts = parts.map(part => {
        // Detect and handle template literals
        if (part.startsWith('`') && part.endsWith('`')) {
            // Extract content inside the template literal, handling potential embedded expressions
            const templateLiteralContent = part.slice(1, -1);
            // Split based on space only if not within an embedded expression
            return handleTemplateLiteral(templateLiteralContent).map(tpart => {
                if (tpart.startsWith('`')) {
                    // For dynamic parts, use computed property syntax
                    return `[${tpart}]: true`;
                } else {
                    // For static parts within a template literal
                    return `'${tpart}': true`;
                }
            }).join(', ');
        } else {
            // Handle regular static class names
            return `'${part}': true`;
        }
    }).join(', ');

    return `:class="{ ${classObjectParts} }"`;
}

function splitClassValue(classValue) {
    // Splits class values while respecting spaces within template literals
    const parts = [];
    let currentPart = '';
    let isInTemplateLiteral = false;
    let braceLevel = 0;

    for (let i = 0; i < classValue.length; i++) {
        const char = classValue[i];
        if (char === '`') {
            isInTemplateLiteral = !isInTemplateLiteral;
            currentPart += char;
        } else if (isInTemplateLiteral && char === '$' && classValue[i + 1] === '{') {
            braceLevel++;
            i++; // Skip '{'
            currentPart += '${';
        } else if (isInTemplateLiteral && char === '}' && braceLevel > 0) {
            braceLevel--;
            currentPart += char;
        } else if (char === ' ' && !isInTemplateLiteral && braceLevel === 0) {
            if (currentPart.trim()) {
                parts.push(currentPart.trim());
                currentPart = '';
            }
        } else {
            currentPart += char;
        }
    }
    if (currentPart.trim()) {
        parts.push(currentPart.trim());
    }
    return parts;
}

function handleTemplateLiteral(content) {
    // This function should split the template literal content into dynamic and static parts
    // For simplicity, assuming direct splitting. This might need more sophisticated parsing.
    return content.split(/\s+/).map(part => {
        // Check if part is dynamic (contains `${...}`)
        if (part.includes('${')) {
            return '`' + part + '`'; // Re-wrap dynamic parts in backticks
        }
        return part; // Static parts are returned as is
    });
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
