import {exec, execFile} from 'child_process';
import {
	App,
	ItemView,
	Modal,
	setIcon,
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

		this.addRibbonIcon("check-square", "Things 3 Today Plus", () => {
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


export class ThingsView extends ItemView {
	intervalValue: NodeJS.Timer;
	refreshTimer: NodeJS.Timer
	plugin: ObsidianThings3
	upcomingVisible: boolean = false;
	upcomingData: string | null = null;

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
		return "Things · Today";
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
		container.createEl("h4", {text: "Things 3 Today"});

		// Top buttons: Open Things + Add To-Do
		const topButtons = container.createEl("div", {cls: "things3-top-buttons"});

		const openBtn = topButtons.createEl("button", {text: "Open Things", cls: "things3-btn"});
		openBtn.addEventListener("click", () => {
			window.open("things:///show?id=today");
		});

		const addBtn = topButtons.createEl("button", {text: "Add To-Do", cls: "things3-btn"});
		addBtn.addEventListener("click", () => {
			new AddTaskModal(this.app, this).open();
		});

		// Task list
		const inputCheckboxes = node.querySelectorAll('.things-today-checkbox');
		inputCheckboxes.forEach((checkbox) => {
			checkbox.addEventListener('click', this.handleCheckboxClick.bind(this));
		});

		while (node.children[1].children.length > 0) {
			container.appendChild(node.children[1].children[0]);
		}

		// Toggle button for upcoming
		const toggleBar = container.createEl("div", {cls: "things3-upcoming-toggle-bar"});
		const toggleBtn = toggleBar.createEl("button", {
			text: this.upcomingVisible ? "Hide Upcoming" : "Show Upcoming",
			cls: "things3-btn",
		});
		toggleBtn.addEventListener("click", async () => {
			this.upcomingVisible = !this.upcomingVisible;
			if (this.upcomingVisible && !this.upcomingData) {
				this.upcomingData = await this.getUpcomingListByJXA();
			}
			this.getAndShowTodayTodos();
		});

		// Upcoming section (conditionally rendered)
		if (this.upcomingVisible) {
			if (!this.upcomingData) {
				this.upcomingData = await this.getUpcomingListByJXA();
			}
			this.renderUpcomingSection(container);
		}

		// Refresh icon at bottom
		const bottomBar = container.createEl("div", {cls: "things3-bottom-refresh"});
		const refreshBtn = bottomBar.createEl("button", {cls: "things3-refresh-icon"});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			this.refreshTodayView(0, true)
		});
	}

	async handleCheckboxClick(event: MouseEvent) {
		const clickedCheckbox = event.target as HTMLInputElement;

		const todoId = clickedCheckbox.attributes.getNamedItem("tid")?.value || ""
		await this.completeTodoByJXA(todoId)

		clickedCheckbox.parentNode?.detach()

		// things3 is too slow to refresh this immediately
		this.refreshTodayView(3000)
	}

	renderUpcomingSection(container: Element) {
		const section = container.createEl("div", {cls: "things3-upcoming-section"});

		let todos: Array<{id: string; name: string; status: string; activationDate: string}> = [];
		try {
			todos = JSON.parse(this.upcomingData || "[]");
		} catch {
			todos = [];
		}

		if (todos.length === 0) {
			section.createEl("div", {text: "No upcoming tasks", cls: "things3-upcoming-empty"});
			return;
		}

		const grouped = this.groupByDate(todos);
		grouped.forEach((tasks, dateKey) => {
			const group = section.createEl("div", {cls: "things3-upcoming-group"});
			const header = group.createEl("div", {cls: "things3-upcoming-header"});
			const {dayNumber, label} = this.formatUpcomingDateHeader(dateKey);
			header.createEl("span", {text: String(dayNumber), cls: "things3-upcoming-day-number"});
			header.createEl("span", {text: label, cls: "things3-upcoming-day-label"});

			tasks.forEach((t) => {
				const row = group.createEl("div", {cls: "things-task-row"});
				const checkbox = row.createEl("input", {type: "checkbox", cls: "things-today-checkbox"});
				checkbox.setAttribute("tid", t.id);
				if (t.status !== "open") {
					checkbox.setAttribute("checked", "");
				}
				checkbox.addEventListener("click", this.handleCheckboxClick.bind(this));
				const link = row.createEl("a", {text: t.name, href: `things:///show?id=${t.id}`});
			});
		});
	}

	formatUpcomingDateHeader(dateStr: string): {dayNumber: number; label: string} {
		const date = new Date(dateStr + "T00:00:00");
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
		const dayNumber = date.getDate();
		const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

		let label: string;
		if (diffDays === 1) {
			label = "Tomorrow";
		} else if (diffDays > 1 && diffDays <= 7) {
			label = weekdays[date.getDay()];
		} else {
			label = `${months[date.getMonth()]} ${weekdays[date.getDay()]}`;
		}
		return {dayNumber, label};
	}

	groupByDate(todos: Array<{id: string; name: string; status: string; activationDate: string}>): Map<string, Array<{id: string; name: string; status: string; activationDate: string}>> {
		const map = new Map<string, Array<{id: string; name: string; status: string; activationDate: string}>>();
		for (const t of todos) {
			const key = new Date(t.activationDate).toLocaleDateString('en-CA');
			if (!map.has(key)) {
				map.set(key, []);
			}
			map.get(key)!.push(t);
		}
		// Sort by date key
		return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
	}

	refreshTodayView(delay?: number, notice = false) {
		clearTimeout(this.refreshTimer)
		this.upcomingData = null;

		this.refreshTimer = setTimeout(() => {
			this.getAndShowTodayTodos();
			if (notice) {
				new Notice("Today Refreshed")
			}
		}, delay);
	}

	getTodayListByJXA(): Promise<string> {
		const getTodayListSct = `"function getTodayList() { let content = ''; Application('Things').lists.byId('TMTodayListSource').toDos().forEach(t => { let checked = t.status()=='open' ? '' : 'checked'; content += '<div class=\\"things-task-row\\"><input '+ checked +' type=\\"checkbox\\" class=\\"things-today-checkbox\\" tid=\\"' + t.id() + '\\"><a href=\\"things:///show?id=' + t.id() + '\\">' + t.name() + '</a></div>'; }); return content; }; getTodayList();"`

		return new Promise((resolve) => {
			exec(`osascript -l JavaScript -e ` + getTodayListSct, (err, stdout, stderr) => {
				resolve(stdout)
			})
		})
	}

	getUpcomingListByJXA(): Promise<string> {
		const getUpcomingSct = `"function getUpcoming() { var now = new Date(); var limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14); var results = []; Application('Things').lists.byId('TMUpcomingListSource').toDos().forEach(function(t) { var d = t.activationDate(); if (d && d <= limit) { var y = d.getFullYear(); var m = ('0' + (d.getMonth()+1)).slice(-2); var day = ('0' + d.getDate()).slice(-2); results.push({id: t.id(), name: t.name(), status: t.status(), activationDate: y+'-'+m+'-'+day}); } }); return JSON.stringify(results); }; getUpcoming();"`

		return new Promise((resolve) => {
			exec(`osascript -l JavaScript -e ` + getUpcomingSct, (err, stdout, stderr) => {
				resolve(stdout.trim())
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

	addTodo(title: string, when: string, notes?: string, tags?: string): Promise<void> {
		const params = new URLSearchParams();
		params.set('title', title);
		params.set('when', when);
		if (notes) params.set('notes', notes);
		if (tags) params.set('tags', tags);

		const url = `things:///add?${params.toString().replace(/\+/g, '%20')}`;

		return new Promise((resolve, reject) => {
			execFile('open', ['-g', url], (err) => {
				if (err) {
					reject(new Error(err.message));
				} else {
					resolve();
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
		contentEl.addClass('things3-add-modal');

		// Title input
		const titleInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "New To-Do",
			cls: "things3-title-input",
		});

		// Notes textarea
		const notesInput = contentEl.createEl("textarea", {
			placeholder: "Notes",
			cls: "things3-notes-input",
		});

		// When selector
		let whenValue = 'today';
		const whenRow = contentEl.createEl("div", {cls: "things3-when-row"});
		const whenBtns = whenRow.createEl("div", {cls: "things3-when-btns"});

		const todayBtn = whenBtns.createEl("button", {text: "Today", cls: "things3-when-btn things3-when-active"});
		const tomorrowBtn = whenBtns.createEl("button", {text: "Tomorrow", cls: "things3-when-btn"});
		const pickDateBtn = whenBtns.createEl("button", {text: "Pick Date", cls: "things3-when-btn"});

		const dateInput = whenRow.createEl("input", {
			type: "date",
			cls: "things3-date-input things3-date-hidden",
		});

		const setWhen = (value: string, activeBtn: HTMLElement) => {
			whenValue = value;
			whenBtns.querySelectorAll('.things3-when-btn').forEach(b => b.removeClass('things3-when-active'));
			activeBtn.addClass('things3-when-active');
		};

		todayBtn.addEventListener("click", () => {
			setWhen('today', todayBtn);
			dateInput.addClass('things3-date-hidden');
		});
		tomorrowBtn.addEventListener("click", () => {
			setWhen('tomorrow', tomorrowBtn);
			dateInput.addClass('things3-date-hidden');
		});
		pickDateBtn.addEventListener("click", () => {
			setWhen(dateInput.value || '', pickDateBtn);
			dateInput.removeClass('things3-date-hidden');
			dateInput.focus();
		});
		dateInput.addEventListener("change", () => {
			whenValue = dateInput.value;
		});

		// Bottom bar: tags + save
		const bottomBar = contentEl.createEl("div", {cls: "things3-bottom-bar"});
		const tagsRow = bottomBar.createEl("div", {cls: "things3-tags-row"});
		const tagIcon = tagsRow.createEl("div", {cls: "things3-tag-icon"});
		setIcon(tagIcon, "tag");
		const tagsInput = tagsRow.createEl("input", {
			type: "text",
			placeholder: "Tags",
			cls: "things3-tags-input",
		});

		// Submit button
		const submitBtn = bottomBar.createEl("button", {
			text: "Save",
			cls: "things3-submit-btn",
		});

		setTimeout(() => titleInput.focus(), 10);

		const submit = async () => {
			const title = titleInput.value.trim();
			if (!title) {
				new Notice("Title is required");
				return;
			}
			try {
				await this.thingsView?.addTodo(
					title,
					whenValue || 'today',
					notesInput.value.trim() || undefined,
					tagsInput.value.trim() || undefined
				);
				const label = whenValue === 'today' ? 'Today' : whenValue === 'tomorrow' ? 'Tomorrow' : whenValue;
				new Notice(`Task added to ${label}`);
				this.close();
				this.thingsView?.refreshTodayView(1000);
			} catch (e) {
				new Notice("Failed to add task: " + (e as Error).message);
			}
		};

		submitBtn.addEventListener("click", submit);

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
