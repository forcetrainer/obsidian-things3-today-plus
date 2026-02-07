import {exec, execFile} from 'child_process';
import {
	App,
	ItemView,
	Modal,
	Setting,
	WorkspaceLeaf,
	Notice,
	Plugin,
} from 'obsidian';

export const VIEW_TYPE_THINGS3 = "things3-today-plus";

export default class ObsidianThings3 extends Plugin {

	async onload() {

		this.addCommand({
			id: 'open-today',
			name: 'Open Today',
			callback: () => {
				this.activateThings3View();
			}
		});

		this.addCommand({
			id: 'add-task-today',
			name: 'Add Task to Today',
			callback: () => {
				new AddTaskModal(this.app, this.getThingsView()).open();
			}
		});

		this.registerView(
			VIEW_TYPE_THINGS3,
			(leaf) => new ThingsView(leaf, this)
		);

		this.addRibbonIcon("check-square", "Open Things3 Today", () => {
			this.activateThings3View();
		});

        // trigger this on layout ready
		this.app.workspace.onLayoutReady(this.activateThings3View.bind(this))
	}

	getThingsView(): ThingsView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_THINGS3);
		if (leaves.length > 0) {
			return leaves[0].view as ThingsView;
		}
		return null;
	}

	async activateThings3View() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_THINGS3);
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_THINGS3, active: true });
        }

        workspace.revealLeaf(leaf);
	}

}

function escapeAppleScript(str: string): string {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

export class ThingsView extends ItemView {
	intervalValue: NodeJS.Timer;
	refreshTimer: NodeJS.Timer
	plugin: ObsidianThings3

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianThings3) {
		super(leaf);
		this.plugin = plugin
	}

	getIcon(): string {
		// https://github.com/obsidianmd/obsidian-api/issues/3
		return "check-square";
	}

	getViewType() {
		return VIEW_TYPE_THINGS3;
	}

	getDisplayText() {
		return "Things3 Today";
	}

	async onOpen() {
		this.refreshTodayView(0);
		this.intervalValue = setInterval(() => {
			this.refreshTodayView(0);
		}, 1000 * 30);
	}

	async onClose() {
		clearInterval(this.intervalValue);
		clearTimeout(this.refreshTimer);
	}

	async getAndShowTodayTodos() {
		const container = this.containerEl.children[1];
		// get today List
		const rawHtml = await this.getTodayListByJXA()
		const parser = new DOMParser();
		const doc = parser.parseFromString(rawHtml, 'text/html')
		const node = doc.documentElement

		container.empty();
		container.createEl("h4", {text: "Things3 Today"});
		container.createEl("a", {href: "things:///show?id=today", text: "Open Today"});
		container.createEl("br");
		container.createEl("br");

		const buttonContainer = container.createEl("div", {
			attr: {style: "display: flex; gap: 4px; margin-bottom: 8px;"}
		});

		const refreshBtn = buttonContainer.createEl("button", {text: "Refresh"});
		refreshBtn.addEventListener("click", () => {
			this.refreshTodayView(0, true)
		});

		const addBtn = buttonContainer.createEl("button", {text: "+"});
		addBtn.addEventListener("click", () => {
			new AddTaskModal(this.app, this).open();
		});

		// add click event
		const inputCheckboxes = node.querySelectorAll('.things-today-checkbox');
		inputCheckboxes.forEach((checkbox) => {
			// console.log(checkbox)
			checkbox.addEventListener('click', this.handleCheckboxClick.bind(this));
		});

		// append body > subEle into container
		while (node.children[1].children.length > 0) {
			container.appendChild(node.children[1].children[0]);
		}
	}

	async handleCheckboxClick(event: MouseEvent) {
		const clickedCheckbox = event.target as HTMLInputElement;

		const todoId = clickedCheckbox.attributes.getNamedItem("tid")?.value || ""
		await this.completeTodoByJXA(todoId)

		clickedCheckbox.parentNode?.detach()

		// things3 is too slow to refresh this immediately
		this.refreshTodayView(3000)
	}

	refreshTodayView(delay?: number, notice = false) {
		clearTimeout(this.refreshTimer)

		this.refreshTimer = setTimeout(() => {
			this.getAndShowTodayTodos();
			if (notice) {
				new Notice("Today Refreshed")
			}
		}, delay);
	}

	getTodayListByJXA(): Promise<string> {
		const getTodayListSct = `"function getTodayList() { let content = ''; Application('Things').lists.byId('TMTodayListSource').toDos().forEach(t => { let checked = t.status()=='open' ? '' : 'checked'; content += '<ul><input '+ checked +'  type="checkbox" class="things-today-checkbox" tid=\\"' + t.id() + '\\"><div style="display:contents"><a href=\\"things:///show?id=' + t.id() + '\\">' + t.name() + '</a></div></ul>'; }); return content; }; getTodayList();"`

		return new Promise((resolve) => {
			exec(`osascript -l JavaScript -e ` + getTodayListSct, (err, stdout, stderr) => {
				resolve(stdout)
			})
		})
	}

	completeTodoByJXA(todoId: string): Promise<string> {
		const completeSct = `"Application('Things').toDos.byId('`+todoId+`').status = 'completed'"`

		return new Promise((resolve) => {
			exec(`osascript -l JavaScript -e ` + completeSct, (err, stdout, stderr) => {
				resolve(stdout)
			})
		})
	}

	addTodoByAppleScript(title: string, notes?: string, tags?: string): Promise<string> {
		const safeTitle = escapeAppleScript(title);
		const safeNotes = notes ? escapeAppleScript(notes) : '';
		const safeTags = tags ? escapeAppleScript(tags) : '';

		let propsStr = `name:"${safeTitle}"`;
		if (notes) {
			propsStr += `, notes:"${safeNotes}"`;
		}
		if (tags) {
			propsStr += `, tag names:"${safeTags}"`;
		}

		const script = `tell application "Things3" to make new to do with properties {${propsStr}} at beginning of list "Today"`;

		return new Promise((resolve, reject) => {
			execFile('osascript', ['-e', script], (err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr || err.message));
				} else {
					resolve(stdout.trim());
				}
			})
		})
	}
}

class AddTaskModal extends Modal {
	thingsView: ThingsView | null;

	constructor(app: App, thingsView: ThingsView | null) {
		super(app);
		this.thingsView = thingsView;
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.createEl("h3", {text: "Add Task to Today"});

		let titleValue = '';
		let notesValue = '';
		let tagsValue = '';

		new Setting(contentEl)
			.setName("Title")
			.addText((text) => {
				text.setPlaceholder("Task title")
					.onChange((value) => { titleValue = value; });
				text.inputEl.id = 'things3-add-title';
				// auto-focus after modal opens
				setTimeout(() => text.inputEl.focus(), 10);
			});

		new Setting(contentEl)
			.setName("Notes")
			.addTextArea((textarea) => {
				textarea.setPlaceholder("Optional notes")
					.onChange((value) => { notesValue = value; });
			});

		new Setting(contentEl)
			.setName("Tags")
			.addText((text) => {
				text.setPlaceholder("tag1, tag2")
					.onChange((value) => { tagsValue = value; });
			});

		const submit = async () => {
			if (!titleValue.trim()) {
				new Notice("Title is required");
				return;
			}
			try {
				await this.thingsView?.addTodoByAppleScript(
					titleValue.trim(),
					notesValue.trim() || undefined,
					tagsValue.trim() || undefined
				);
				new Notice("Task added to Today");
				this.close();
				this.thingsView?.refreshTodayView(1000);
			} catch (e) {
				new Notice("Failed to add task: " + (e as Error).message);
			}
		};

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Add Task")
					.setCta()
					.onClick(submit);
			});

		// Enter key submits from title/tags inputs
		contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
				e.preventDefault();
				submit();
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
